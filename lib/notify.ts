// Telegram push notifications — pings the owner when something needs them.
// No-op until TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set.
export async function notify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch {
    // Never let a notification failure break the agent flow.
  }
}
