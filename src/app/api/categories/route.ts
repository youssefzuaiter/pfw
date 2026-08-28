import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { createCategory } from "../../../server/dal/categories";
import { slugify } from "../../../lib/slugify";

const CreateBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(60, "name is too long"),
});

const MAX_SLUG_RETRIES = 5;

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "categories:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = CreateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const baseSlug = slugify(parsed.data.name);

    // Slugs are permanent once created (the "permanent category slugs"
    // law), so a collision (two categories that slugify to the same
    // value) needs a distinct slug up front — appending a counter is
    // simplest and never needs to change again afterward.
    for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const result = await createCategory(user.id, { slug, name: parsed.data.name });
      if (result.ok) {
        return NextResponse.json({ ok: true, category: result.category }, { status: 201 });
      }
    }

    return jsonBadRequest("Could not generate a unique category identifier — try a different name");
  } catch (error) {
    console.error("POST /api/categories failed", error);
    return jsonServerError();
  }
}
