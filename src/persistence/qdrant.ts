import { QdrantClient } from "@qdrant/js-client-rest";
import OpenAI from "openai";
import crypto from "crypto";
import {
  QDRANT_URL,
  COLLECTION_NAME,
  OPENAI_API_KEY,
  QDRANT_API_KEY
} from "../config.js";
import { Entity, Relation } from "../types.js";

interface EntityPayload extends Entity {
  type: "entity";
}

interface QdrantCollectionConfig {
  params: {
    vectors: {
      size: number;
      distance: string;
    };
  };
}

interface QdrantCollectionInfo {
  config: QdrantCollectionConfig;
}

interface RelationPayload extends Relation {
  type: "relation";
}

type Payload = EntityPayload | RelationPayload;

function isEntity(payload: Payload): payload is EntityPayload {
  return (
    payload.type === "entity" &&
    typeof payload.name === "string" &&
    typeof payload.entityType === "string" &&
    Array.isArray(payload.observations) &&
    payload.observations.every((obs: unknown) => typeof obs === "string")
  );
}

function isRelation(payload: Payload): payload is RelationPayload {
  return (
    payload.type === "relation" &&
    typeof payload.from === "string" &&
    typeof payload.to === "string" &&
    typeof payload.relationType === "string"
  );
}

export class QdrantPersistence {
  private client: QdrantClient;
  private openai: OpenAI;
  private initialized: boolean = false;

  constructor() {
    if (!QDRANT_URL) {
      throw new Error("QDRANT_URL environment variable is required");
    }

    // Validate QDRANT_URL format and protocol
    if (
      !QDRANT_URL.startsWith("http://") &&
      !QDRANT_URL.startsWith("https://")
    ) {
      throw new Error("QDRANT_URL must start with http:// or https://");
    }

    this.client = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY,
      timeout: 60000,
      checkCompatibility: false, // Disable version check
    });

    console.log(`QdrantClient configured with URL: ${QDRANT_URL}`);

    this.openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });
  }

  async connect() {
    if (this.initialized) return;

    // Add retry logic for initial connection with exponential backoff
    let retries = 3;
    let delay = 2000; // Start with 2 second delay

    while (retries > 0) {
      try {
        console.log(`Attempting to connect to Qdrant (attempt ${4 - retries}/3)`);
        await this.client.getCollections();
        console.log('Successfully connected to Qdrant');
        this.initialized = true;
        break;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown Qdrant error";
        console.error(`Connection attempt failed: ${message}`);
        console.error("Full error:", error);

        retries--;
        if (retries === 0) {
          throw new Error(
            `Failed to connect to Qdrant after multiple attempts: ${message}`
          );
        }
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      }
    }

    console.log('Qdrant connection process completed.');
  }

    private async recreateCollection(vectorSize: number) {
        if (!COLLECTION_NAME) {
            throw new Error("COLLECTION_NAME environment variable is required in recreateCollection");
        }

        try {
            console.log(`Deleting collection ${COLLECTION_NAME}...`);
            await this.client.deleteCollection(COLLECTION_NAME);
            console.log(`Creating collection ${COLLECTION_NAME} with vector size ${vectorSize}...`);
            await this.client.createCollection(COLLECTION_NAME, {
                vectors: {
                size: vectorSize,
                distance: 'Cosine',
                },
            });
            console.log(`Collection recreated with new vector size ${vectorSize}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown Qdrant error";
            throw new Error(`Failed to recreate collection: ${message}`);
        }
    }

    async initialize() {
        await this.connect();

        if (!COLLECTION_NAME) {
            throw new Error("COLLECTION_NAME environment variable is required");
        }

        const requiredVectorSize = 1536; // OpenAI embedding dimension

        try {
            // Check if collection exists
            console.log(`Checking if collection ${COLLECTION_NAME} exists...`);
            const collections = await this.client.getCollections();
            const collection = collections.collections.find(
                (c) => c.name === COLLECTION_NAME
            );

            if (!collection) {
                console.log(
                `Creating new collection ${COLLECTION_NAME} with vector size ${requiredVectorSize}`
                );
                await this.client.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: requiredVectorSize,
                    distance: "Cosine",
                },
                });
                return;
            }

            // Get collection info to check vector size
            console.log(`Retrieving collection info for ${COLLECTION_NAME}...`);
            const collectionInfo = (await this.client.getCollection(
                COLLECTION_NAME
            )) as QdrantCollectionInfo;
            const currentVectorSize =
                collectionInfo.config?.params?.vectors?.size;

            if (!currentVectorSize) {
                console.log(
                "Could not determine current vector size, recreating collection..."
                );
                await this.recreateCollection(requiredVectorSize);
                return;
            }

            if (currentVectorSize !== requiredVectorSize) {
                console.log(
                `Vector size mismatch: collection=${currentVectorSize}, required=${requiredVectorSize}`
                );
                await this.recreateCollection(requiredVectorSize);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown Qdrant error';
            console.error("Failed to initialize collection:", message);
            throw new Error(
                `Failed to initialize Qdrant collection. Please check server logs for details: ${message}`
            );
        }
    }

  private async generateEmbedding(text: string) {
    try {
      const response = await this.openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown OpenAI error";
      console.error("OpenAI embedding error:", message);
      throw new Error(`Failed to generate embeddings with OpenAI: ${message}`);
    }
  }

  private async hashString(str: string) {
    const hash = crypto.createHash("sha256");
    hash.update(str);
    const buffer = hash.digest();
    return buffer.readUInt32BE(0);
  }

  async persistEntity(entity: Entity) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const text = `${entity.name} (${
      entity.entityType
    }): ${entity.observations.join(". ")}`;
    const vector = await this.generateEmbedding(text);
    const id = await this.hashString(entity.name);

    const payload = {
      type: "entity",
      ...entity,
    };

    await this.client.upsert(COLLECTION_NAME, {
      points: [
        {
          id,
          vector,
          payload: payload as Record<string, unknown>,
        },
      ],
    });
  }

  async persistRelation(relation: Relation) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const text = `${relation.from} ${relation.relationType} ${relation.to}`;
    const vector = await this.generateEmbedding(text);
    const id = await this.hashString(
      `${relation.from}-${relation.relationType}-${relation.to}`
    );

    const payload = {
      type: "relation",
      ...relation,
    };

    await this.client.upsert(COLLECTION_NAME, {
      points: [
        {
          id,
          vector,
          payload: payload as Record<string, unknown>,
        },
      ],
    });
  }

  async searchSimilar(query: string, limit: number = 10) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const queryVector = await this.generateEmbedding(query);

    const results = await this.client.search(COLLECTION_NAME, {
      vector: queryVector,
      limit,
      with_payload: true,
    });

    const validResults: Array<Entity | Relation> = [];

    for (const result of results) {
      if (!result.payload) continue;

      const payload = result.payload as unknown as Payload;

      if (isEntity(payload)) {
        const { type, ...entity } = payload;
        validResults.push(entity);
      } else if (isRelation(payload)) {
        const { type, ...relation } = payload;
        validResults.push(relation);
      }
    }

    return validResults;
  }

  async deleteEntity(entityName: string) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const id = await this.hashString(entityName);
    await this.client.delete(COLLECTION_NAME, {
      points: [id],
    });
  }

  async deleteRelation(relation: Relation) {
    await this.connect();
    if (!COLLECTION_NAME) {
      throw new Error("COLLECTION_NAME environment variable is required");
    }

    const id = await this.hashString(
      `${relation.from}-${relation.relationType}-${relation.to}`
    );
    await this.client.delete(COLLECTION_NAME, {
      points: [id],
    });
  }
}
