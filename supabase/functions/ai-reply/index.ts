
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import {
  createReply,
  createGeminiGenerator,
  searchAmazon,
} from "../../../src/ai/index.ts";
import type { AIInput } from "../../../src/shared/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(supabaseUrl, supabaseServiceKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return json({ error: "POSTのみ対応しています" }, 405);
  }

  try {
    // 1. ログインユーザーを認証する
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return json({ error: "ログインが必要です" }, 401);
    }

    const token = authorization.slice(7);
    const { data: authData, error: authError } =
      await admin.auth.getUser(token);

    if (authError || !authData.user) {
      return json({ error: "認証に失敗しました" }, 401);
    }

    const userId = authData.user.id;

    // 2. 相談文を受け取る
    const body = await req.json();
    const message = body?.message;
    const conversationId = body?.conversationId;

    if (typeof message !== "string" ||
        !message.trim() ||
        message.length > 4000) {
      return json({ error: "相談文が不正です" }, 400);
    }

    // 3. ユーザーの役割をDBから取得する
    const { data: user, error: userError } = await admin
      .from("users")
      .select("role, age_group")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return json({ error: "ユーザー情報がありません" }, 404);
    }

    // 4. 本人の会話を取得または作成する
    let activeConversationId: string;

    if (conversationId !== undefined && conversationId !== null) {
      if (typeof conversationId !== "string") {
        return json({ error: "会話IDが不正です" }, 400);
      }

      const { data: conversation, error } = await admin
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .eq("kind", "private_ai")
        .single();

      if (error || !conversation) {
        return json({ error: "会話が見つかりません" }, 404);
      }

      activeConversationId = conversation.id;
    } else {
      const { data: conversation, error } = await admin
        .from("conversations")
        .insert({ user_id: userId, kind: "private_ai" })
        .select("id")
        .single();

      if (error || !conversation) {
        return json({ error: "会話を作成できませんでした" }, 500);
      }

      activeConversationId = conversation.id;
    }

    // 5. 本人の会話履歴を取得する（最大40件）
    const { data: rows, error: historyError } = await admin
      .from("messages")
      .select("id, sender, content, created_at")
      .eq("conversation_id", activeConversationId)
      .in("sender", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(40);

    if (historyError) {
      return json({ error: "会話履歴を取得できませんでした" }, 500);
    }

    const history = (rows ?? []).reverse().map((row) => ({
      id: row.id,
      sender: row.sender as "user" | "assistant",
      content: row.content,
      createdAt: row.created_at,
    }));

    // 6. 本人のプロフィールを取得する
    const { data: preferences, error: preferencesError } = await admin
      .from("user_preferences")
      .select(
        "interests, desired_items, expected_activities"
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (preferencesError) {
      return json({ error: "プロフィールを取得できませんでした" }, 500);
    }

    // age_groupは年齢そのものではないため、推測しない
    const profile = {
      age: null,
      gender: null,
      preferences: {
        interests: preferences?.interests ?? [],
        wishes: preferences?.desired_items ?? [],
        expectations: preferences?.expected_activities ?? [],
      },
    };

    // 7. AIInputをバックエンド側で組み立てる
    const input: AIInput = {
      requestId: crypto.randomUUID(),
      now: new Date().toISOString(),
      role: user.role as "parent" | "child",
      mode: "consultation",
      message: message.trim(),
      history,
      negotiationHistory: [],
      profile,
      sharedConditions: [],
      constraints: {
        mustHave: [],
        mustAvoid: [],
      },
      products: [],
      selectedProductId: null,
      currentProposal: null,
      negotiationResult: null,
    };

    // 8. Geminiをサーバー側から呼び出す
    const apiKey = Deno.env.get("GEMINI_API_KEY");

    if (!apiKey) {
      return json({ error: "AIの設定が未完了です" }, 503);
    }

    const output = await createReply(input, {
      generate: createGeminiGenerator({ apiKey }),
      search: searchAmazon,
    });

    // 9. 本人の発言を保存する
    const { error: messageError } = await admin
      .from("messages")
      .insert({
        conversation_id: activeConversationId,
        sender: "user",
        content: message.trim(),
      });

    if (messageError) {
      return json({ error: "発言を保存できませんでした" }, 500);
    }

    // 10. AIの返答を保存する
    const { error: replyError } = await admin
      .from("messages")
      .insert({
        conversation_id: activeConversationId,
        sender: "assistant",
        content: output.reply,
        response_type: output.action,
        search_metadata: output.search,
    });

    if (replyError) {
      console.error("AI返答の保存に失敗しました", replyError);
      return json({ error: "AIの返答を保存できませんでした" }, 500);
    }

    // 11. フロントへ返す
    return json({
      conversationId: activeConversationId,
      ...output,
    });
  } catch (error) {
    console.error("ai-reply failed", error instanceof Error ? error.name : "UnknownError");
    return json({ error: "AIの処理に失敗しました" }, 500);
  }
});
