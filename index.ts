export interface FigmaComponent {
  key: string;
  name: string;
  description: string;
  remote: boolean;
  documentationLinks: string[];
}

type FigmaComponentWithId = FigmaComponent & { id: string };

export interface FigmaFile {
  document: {
    children: any[];
    name: string;
  };
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

  async import(options: {
    fileId: string;
    version?: string;
    nodeId?: string;
  }): Promise<Record<string, string>> {
    const fileId = options.fileId;
    const version = options.version;
    const nodeId = options.nodeId;

    if (!fileId) {
      throw new Error("File key is required");
    }

    console.log("fetching file", fileId, version);

    const data = await this.fetchFile(fileId, version);

    // Get all components from the file
    const componentEntries = Object.entries(data.components || {});

    if (componentEntries.length === 0) {
      return {};
    }

    // Create component list with IDs
    const allComponents: FigmaComponentWithId[] = componentEntries.map(
      ([id, component]) => ({
        ...component,
        id,
      })
    );

    // Filter components by nodeId if provided
    let componentList = allComponents;

    console.log("found", allComponents.length, "components");

    if (nodeId) {
      // Find the specified node in the document
      const findNode = (nodes: any[]): any | undefined => {
        for (const node of nodes) {
          if (node.id === nodeId) {
            return node;
          }
          if (node.children) {
            const found = findNode(node.children);
            if (found) return found;
          }
        }
        return undefined;
      };

      const targetNode = findNode(data.document.children);

      console.log("found node", nodeId, targetNode);

      if (targetNode) {
        // Collect all component IDs within this node and its children
        const collectComponentIds = (
          node: any,
          ids: Set<string> = new Set()
        ): Set<string> => {
          if (node.componentId) {
            ids.add(node.componentId);
          }
          if (node.children) {
            for (const child of node.children) {
              collectComponentIds(child, ids);
            }
          }
          return ids;
        };

        const nodeComponentIds = collectComponentIds(targetNode);

        // Filter the component list to only include components within the specified node
        componentList = allComponents.filter((component) =>
          nodeComponentIds.has(component.id)
        );
      }
    }

    const componentIds = componentList.map((c) => c.id);

    // If no components found after filtering, return empty result
    if (componentIds.length === 0) {
      return {};
    }

    const svgUrls = await this.fetchComponentSVGs(
      fileId,
      componentIds,
      version
    );

    const svgFiles = await Promise.all(
      componentList.flatMap(async (component) => {
        const svgUrl = svgUrls[component.id];

        let svgString: string;
        try {
          svgString = await this.fetchSVGContent(svgUrl);
        } catch (error) {
          console.error(`Failed to fetch SVG for ${component.name}:`, error);
          return [];
        }

        console.log("fetched svg for component", component.name);

        return [
          [`${component.name}.svg`, { type: "file", content: svgString }],
        ];
      })
    );

    return Object.fromEntries(svgFiles);
  }
}

type Inputs = {
  fileId: string;
  FIGMA_TOKEN: string;
  nodeId?: string;
};

export default async function main({ fileId, FIGMA_TOKEN, nodeId }: Inputs) {
  const figmaService = new FigmaService({
    token: FIGMA_TOKEN,
  });

  const results = await figmaService.import({
    fileId,
    nodeId,
  });

  return results;
}
