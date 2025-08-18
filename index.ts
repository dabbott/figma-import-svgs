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

type File = {
  id: string;
  kind: "file";
  content: string;
  encoding: "utf-8";
};

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
  ): Promise<Record<string, File>> {
    const version = options.version;

    let fileId: string | undefined = options.fileId;
    let parentNodeId: string | undefined = options.parentNodeId;

    if (!fileId && options.fileUrl) {
      const parsed = parseFileUrl(options.fileUrl);
      fileId = parsed.fileId;
      if (!parentNodeId && parsed.nodeId) {
        parentNodeId = parsed.nodeId;
      }
    }

    if (!fileId) {
      throw new Error("File ID could not be determined from inputs");
    }

    console.log("🔍 Fetching Figma file", fileId);

    const data = await this.fetchFile(fileId, version);

    console.log("✅ Fetched Figma file");

    const componentEntries = Object.entries(data.components || {});

    if (componentEntries.length === 0) {
      return {};
    }

    let componentIds = Object.keys(data.components);

    if (parentNodeId) {
      const normalizedParentNodeId = parentNodeId.replaceAll(/-/g, ":");

      const node = tree.find(
        data.document,
        (node) => node.id === normalizedParentNodeId
      );

      if (!node) {
        throw new Error(`Parent node with id ${parentNodeId} not found`);
      }

      console.log("🔍 Looking for children of node", node.name);

      const descendantComponents = tree.findAll(
        node,
        (node) => node.type === "COMPONENT"
      );

      const descendantComponentIds = new Set(
        descendantComponents.map((c) => c.id)
      );

      componentIds = Array.from(descendantComponentIds);
    }

    console.log("✅ Found", componentIds.length, "components");

    const svgUrls = await this.fetchComponentSVGs(
      fileId,
      componentIds,
      version
    );

    const componentsWithUrls = componentIds.flatMap((componentId) => {
      const svgUrl = svgUrls[componentId];

      const component = data.components[componentId];

      if (!svgUrl) {
        console.warn(
          "SVG URL not found for component",
          component.name,
          componentId
        );

        return [];
      }

      return [
        {
          component,
          url: svgUrl,
        },
      ];
    });

    const svgFiles = await Promise.all(
      componentsWithUrls.map(async (componentWithUrl) => {
        console.log("🔍 Fetching SVG for", componentWithUrl.component.name);

        const svgString = await this.fetchSVGContent(componentWithUrl.url);

        return [
          `${componentWithUrl.component.name}.svg`,
          {
            id: crypto.randomUUID(),
            kind: "file",
            content: svgString,
            encoding: "utf-8",
          },
        ];
      })
    );

    console.log("✅ Fetched all SVGs");

    return Object.fromEntries(svgFiles);
  }
}

// example: https://www.figma.com/design/1234567890/File-Name?node-id=123-456&p=f&t=1234567890
function parseFileUrl(fileUrl: string): { fileId: string; nodeId?: string } {
  const url = new URL(fileUrl);

  const pathSegments = url.pathname.split("/").filter(Boolean);

  let fileId: string | undefined;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    const segment = pathSegments[i];
    if (segment === "file" || segment === "design" || segment === "proto") {
      fileId = pathSegments[i + 1];
      break;
    }
  }

  if (!fileId) {
    throw new Error("Invalid Figma URL: could not extract file ID");
  }

  const nodeIdParam = url.searchParams.get("node-id") ?? undefined;
  return { fileId, nodeId: nodeIdParam };
}

type Inputs = {
  fileUrl?: string;
  fileId?: string;
  parentNodeId?: string;
  version?: string;
  FIGMA_TOKEN: string;
};

export default async function main({ FIGMA_TOKEN, ...inputs }: Inputs) {
  if (!inputs.fileId && !inputs.fileUrl) {
    throw new Error("File ID or URL is required");
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
