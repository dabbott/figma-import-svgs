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
  }): Promise<Record<string, string>> {
    const fileId = options.fileId;
    const version = options.version;

    console.log("Fetching Figma file", fileId, version);

    const data = await this.fetchFile(fileId, version);
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

    const componentIds = componentList.map((c) => c.id);

    const svgUrls = await this.fetchComponentSVGs(
      fileId,
      componentIds,
      version
    );

    const svgFiles = await Promise.all(
      componentList.map(async (component) => {
        const svgUrl = svgUrls[component.id];

        console.log("Fetching content", svgUrl);

        const svgString = await this.fetchSVGContent(svgUrl);

        return [`${component.name}.svg`, { type: "file", content: svgString }];
      })
    );

    return Object.fromEntries(svgFiles);
  }
}

type Inputs = {
  fileId: string;
  FIGMA_TOKEN: string;
};

export default async function main({ fileId, FIGMA_TOKEN }: Inputs) {
  if (!fileId) {
    throw new Error("File ID is required");
  }

  if (!FIGMA_TOKEN) {
    throw new Error("Figma token is required");
  }

  const figmaService = new FigmaService({
    token: FIGMA_TOKEN,
  });

  const results = await figmaService.import({
    fileId,
  });

  return results;
}
