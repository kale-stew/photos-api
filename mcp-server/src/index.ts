#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as api from "./api-client.js";

const server = new Server(
  {
    name: "photos-api-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const TOOLS: Tool[] = [
  {
    name: "search_photos",
    description:
      "Search photos by natural language query. Searches title, caption, location, tags, AI caption, and AI keywords.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query (e.g. 'sunset at the beach', 'iPhone photos from 2024')",
        },
        site: {
          type: "string",
          enum: ["climb-log", "kylieis-online", "both"],
          description: "Filter by site",
        },
        limit: {
          type: "number",
          default: 20,
          description: "Max results (max 50)",
        },
        offset: {
          type: "number",
          default: 0,
          description: "Pagination offset",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_random_photo",
    description: "Return a single random photo. Optionally filter by site or tag.",
    inputSchema: {
      type: "object",
      properties: {
        site: {
          type: "string",
          enum: ["climb-log", "kylieis-online", "both"],
          description: "Filter by site",
        },
        tag: {
          type: "string",
          description: "Filter by tag",
        },
      },
      required: [],
    },
  },
  {
    name: "get_photo",
    description: "Get a single photo's metadata by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Photo ID",
        },
        includeExif: {
          type: "boolean",
          default: false,
          description: "Include EXIF metadata",
        },
        includeAiAnalysis: {
          type: "boolean",
          default: false,
          description: "Include AI caption, keywords, and quality score",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "update_photo",
    description:
      "Update photo metadata. Admin-only (requires Cf-Access-Jwt-Assertion).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Photo ID",
        },
        title: {
          type: "string",
          description: "New title",
        },
        caption: {
          type: "string",
          description: "New caption",
        },
        location: {
          type: "string",
          description: "New location",
        },
        date: {
          type: "string",
          description: "New date (YYYY-MM-DD)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags array",
        },
        site: {
          type: "string",
          enum: ["climb-log", "kylieis-online", "both"],
          description: "New site",
        },
        exclude: {
          type: "boolean",
          description: "Exclude from public lists",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_photos",
    description: "List photos with pagination. Optionally filter by site.",
    inputSchema: {
      type: "object",
      properties: {
        site: {
          type: "string",
          enum: ["climb-log", "kylieis-online", "both"],
          description: "Filter by site",
        },
        limit: {
          type: "number",
          default: 20,
          description: "Max results (max 50)",
        },
        offset: {
          type: "number",
          default: 0,
          description: "Pagination offset",
        },
      },
      required: [],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "search_photos": {
        const { query, site, limit, offset } = args as {
          query: string;
          site?: string;
          limit?: number;
          offset?: number;
        };
        result = await api.searchPhotos({
          q: query,
          site,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        break;
      }

      case "get_random_photo": {
        const { site, tag } = args as {
          site?: string;
          tag?: string;
        };
        result = await api.getRandomPhoto({ site, tag });
        break;
      }

      case "get_photo": {
        const { id, includeExif, includeAiAnalysis } = args as {
          id: string;
          includeExif?: boolean;
          includeAiAnalysis?: boolean;
        };
        result = await api.getPhoto(id, {
          exif: includeExif,
          ai: includeAiAnalysis,
        });
        break;
      }

      case "update_photo": {
        const { id, ...fields } = args as {
          id: string;
          title?: string;
          caption?: string;
          location?: string;
          date?: string;
          tags?: string[];
          site?: string;
          exclude?: boolean;
        };
        result = await api.updatePhoto(id, fields);
        break;
      }

      case "list_photos": {
        const { site, limit, offset } = args as {
          site?: string;
          limit?: number;
          offset?: number;
        };
        result = await api.listPhotos({
          site,
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
