import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  IDEAS_FAILURE_MESSAGES,
  IDEAS_FAILURE_STATUS,
  type IdeasFailure,
  type IdeasFailureReason,
} from "@/lib/ideas/errors";
import { IdeaStatusUpdateSchema, type IdeaStatus } from "@/lib/ideas/schema";
import { createClient } from "@/lib/supabase/server";

export type StatusSuccess = { ok: true; idea: { id: string; status: IdeaStatus } };
export type StatusResponse = StatusSuccess | IdeasFailure;

function fail(reason: IdeasFailureReason) {
  return NextResponse.json<IdeasFailure>(
    { ok: false, reason, message: IDEAS_FAILURE_MESSAGES[reason] },
    { status: IDEAS_FAILURE_STATUS[reason] },
  );
}

/** Set an idea's status to new / saved / dismissed. Nothing else can change. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/ideas/[id]">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("unauthorized");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("invalid_input");

  const body = IdeaStatusUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail("invalid_input");

  // Runs as the user: RLS limits it to their own rows and the column grant
  // limits it to `status`. The user_id filter is belt and braces.
  const { data, error } = await supabase
    .from("generated_ideas")
    .update({ status: body.data.status })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, status")
    .maybeSingle();
  if (error) {
    console.error("[ideas] status update failed", error.message);
    return fail("server_error");
  }
  if (!data) return fail("not_found");

  return NextResponse.json<StatusSuccess>({ ok: true, idea: data as StatusSuccess["idea"] });
}
