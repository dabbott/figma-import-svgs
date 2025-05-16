import { defineTree } from "tree-visit";

type FigmaNode = {
  id: string;
  name: string;
  children: FigmaNode[];
  type: "FRAME" | "COMPONENT" | "DOCUMENT" | "CANVAS" | "PAGE";
};

const tree = defineTree<FigmaNode>((node) =>
  "children" in node && Array.isArray(node.children) ? node.children : []
).withOptions({
  getLabel: (node) => node.name,
});

export interface FigmaComponent {
  key: string;
  name: string;
  description: string;
  remote: boolean;
  documentationLinks: string[];
}

type FigmaComponentWithId = FigmaComponent & { id: string };

export interface FigmaFile {
  document: FigmaNode;
  components: { [key: string]: FigmaComponent };
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  version: string;
}

export interface FigmaError {
  status: number;
  err: string;
}

interface FigmaServiceOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
}

export const FIGMA_API_BASE_URL = "https://api.figma.com/v1";

export class FigmaService {
  private readonly options: Required<FigmaServiceOptions>;

  constructor(options: FigmaServiceOptions) {
    this.options = {
      ...options,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    };
  }

  private getPersonalAccessTokenHeaders() {
    return {
      "X-Figma-Token": this.options.token,
    };
  }

  private getBearerTokenHeaders() {
    return {
      Authorization: `Bearer ${this.options.token}`,
    };
  }

  private getHeaders() {
    const token = this.options.token;

    if (token.startsWith("figd")) {
      return this.getPersonalAccessTokenHeaders();
    }

    return this.getBearerTokenHeaders();
  }

  async fetchFile(fileId: string, version?: string): Promise<FigmaFile> {
    const url = new URL(`${FIGMA_API_BASE_URL}/files/${fileId}`);

    if (version) {
      url.searchParams.set("version", version);
    }

    const response = await this.options.fetch(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorData: FigmaError = await response.json();
      throw new Error(errorData.err || "Failed to fetch Figma file");
    }

    return response.json();
  }

  async fetchComponentSVGs(
    fileId: string,
    componentIds: string[],
    version?: string
  ): Promise<{ [key: string]: string }> {
    const url = new URL(`${FIGMA_API_BASE_URL}/images/${fileId}`);
    url.searchParams.set("ids", componentIds.join(","));
    url.searchParams.set("format", "svg");
    if (version) {
      url.searchParams.set("version", version);
    }

    const response = await this.options.fetch(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorData: FigmaError = await response.json();
      throw new Error(errorData.err || "Failed to fetch component SVGs");
    }

    const data = await response.json();
    return data.images;
  }

  async fetchSVGContent(url: string): Promise<string> {
    const response = await this.options.fetch(url);
    if (!response.ok) {
      throw new Error("Failed to fetch SVG content");
    }
    return response.text();
  }

  async import(
    options: Omit<Inputs, "FIGMA_TOKEN">
  ): Promise<Record<string, string>> {
    const fileId = options.fileId;
    const version = options.version;

    console.log("Fetching Figma file", fileId, version);

    const data = await this.fetchFile(fileId, version);

    console.log("Fetched Figma file", data);

    const componentEntries = Object.entries(data.components || {});

    if (componentEntries.length === 0) {
      return {};
    }

    const componentList: FigmaComponentWithId[] = componentEntries.map(
      ([id, component]) => ({
        ...component,
        id,
      })
    );

    let componentIds = componentList.map((c) => c.id);

    console.log("File", tree.diagram(data.document));

    if (options.nodeId) {
      const node = tree.find(
        data.document,
        (node) => node.id === options.nodeId
      );

      if (!node) {
        throw new Error(`Node with id ${options.nodeId} not found`);
      }

      console.log("Looking for children of node", node.name);

      const descendantComponents = tree.findAll(
        node,
        (node) => node.type === "COMPONENT"
      );

      const descendantComponentIds = new Set(
        descendantComponents.map((c) => c.id)
      );

      componentIds = Array.from(descendantComponentIds);
    }

    console.log("Found", componentIds.length, "components");

    const svgUrls = await this.fetchComponentSVGs(
      fileId,
      componentIds,
      version
    );

    const svgFiles = await Promise.all(
      componentList.map(async (component) => {
        const svgUrl = svgUrls[component.id];

        console.log("Fetching SVG for", component.name);

        const svgString = await this.fetchSVGContent(svgUrl);

        return [`${component.name}.svg`, { type: "file", content: svgString }];
      })
    );

    return Object.fromEntries(svgFiles);
  }
}

type Inputs = {
  fileId: string;
  nodeId?: string;
  version?: string;
  FIGMA_TOKEN: string;
};

export default async function main({ FIGMA_TOKEN, ...inputs }: Inputs) {
  if (!inputs.fileId) {
    throw new Error("File ID is required");
  }

  if (!FIGMA_TOKEN) {
    throw new Error("Figma token is required");
  }

  const figmaService = new FigmaService({
    token: FIGMA_TOKEN,
  });

  const results = await figmaService.import(inputs);

  return results;
}
