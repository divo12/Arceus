import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Readable } from "node:stream";
import type { StorageProvider, GetObjectResult, HeadObjectResult } from "./types.js";
import { notFound, unprocessable } from "../errors.js";

interface SupabaseProviderConfig {
  projectUrl: string;
  serviceRoleKey: string;
  bucket: string;
}

export function createSupabaseStorageProvider(config: SupabaseProviderConfig): StorageProvider {
  const { projectUrl, serviceRoleKey, bucket } = config;
  if (!projectUrl) throw unprocessable("Supabase storage project URL is required");
  if (!serviceRoleKey) throw unprocessable("Supabase storage service role key is required");
  if (!bucket) throw unprocessable("Supabase storage bucket name is required");

  const supabase: SupabaseClient = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    id: "supabase",

    async putObject(input) {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(input.objectKey, input.body, {
          contentType: input.contentType,
          upsert: true,
        });
      if (error) {
        throw unprocessable(`Supabase storage upload failed: ${error.message}`);
      }
    },

    async getObject(input): Promise<GetObjectResult> {
      const { data, error } = await supabase.storage
        .from(bucket)
        .download(input.objectKey);
      if (error) {
        if (error.message?.includes("not found") || error.message?.includes("Not Found")) {
          throw notFound("Object not found");
        }
        throw unprocessable(`Supabase storage download failed: ${error.message}`);
      }
      if (!data) throw notFound("Object not found");

      const buffer = Buffer.from(await data.arrayBuffer());
      return {
        stream: Readable.from(buffer),
        contentType: data.type || undefined,
        contentLength: buffer.byteLength,
      };
    },

    async headObject(input): Promise<HeadObjectResult> {
      const parts = input.objectKey.split("/");
      const fileName = parts.pop() ?? input.objectKey;
      const folder = parts.join("/");

      const { data, error } = await supabase.storage
        .from(bucket)
        .list(folder, { limit: 1, search: fileName });

      if (error || !data || data.length === 0) {
        return { exists: false };
      }

      const file = data.find((f) => f.name === fileName);
      if (!file) return { exists: false };

      return {
        exists: true,
        contentLength: file.metadata?.size ?? undefined,
        contentType: file.metadata?.mimetype ?? undefined,
        lastModified: file.updated_at ? new Date(file.updated_at) : undefined,
      };
    },

    async deleteObject(input): Promise<void> {
      const { error } = await supabase.storage
        .from(bucket)
        .remove([input.objectKey]);
      if (error) {
        throw unprocessable(`Supabase storage delete failed: ${error.message}`);
      }
    },
  };
}
