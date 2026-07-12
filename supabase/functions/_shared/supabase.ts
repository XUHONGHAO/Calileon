/* eslint-disable */

import { createClient } from "npm:@supabase/supabase-js@2";

const requireEnv = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`missing-${name.toLowerCase()}`);
  }
  return value;
};

export const createUserClient = (request: Request) =>
  createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      global: {
        headers: {
          Authorization: request.headers.get("Authorization") || "",
        },
      },
      auth: { persistSession: false },
    },
  );

export const createServiceClient = () =>
  createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
