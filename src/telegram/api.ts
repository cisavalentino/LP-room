/** Minimal Telegram Bot API client (fetch-based, long polling). */

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: { id: number; username?: string }; message?: TgMessage; data?: string };
}

export interface TelegramTransport {
  sendMessage(chatId: string, text: string, buttons?: InlineButton[][]): Promise<void>;
  getUpdates(offset: number, timeoutS: number): Promise<TgUpdate[]>;
  answerCallback(callbackId: string, text: string): Promise<void>;
}

const MAX_LEN = 4000;

export class TelegramApi implements TelegramTransport {
  private readonly base: string;
  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    // Never include the URL (it contains the token) in errors.
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result;
  }

  async sendMessage(chatId: string, text: string, buttons?: InlineButton[][]): Promise<void> {
    for (let i = 0; i < text.length || i === 0; i += MAX_LEN) {
      const chunk = text.slice(i, i + MAX_LEN);
      const last = i + MAX_LEN >= text.length;
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...(buttons && last ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
    }
  }

  getUpdates(offset: number, timeoutS: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] },
      (timeoutS + 10) * 1000,
    );
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }
}

/** Used when no token is configured: logs messages to stdout. */
export class ConsoleTransport implements TelegramTransport {
  readonly sent: { chatId: string; text: string; buttons?: InlineButton[][] }[] = [];
  constructor(private readonly echo = true) {}
  async sendMessage(chatId: string, text: string, buttons?: InlineButton[][]): Promise<void> {
    this.sent.push({ chatId, text, buttons });
    if (this.echo) console.log(`[telegram→${chatId}]\n${text}`);
  }
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async answerCallback(): Promise<void> {}
}
