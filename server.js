'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const IS_VERCEL = Boolean(process.env.VERCEL);
const PUBLIC_DIR = path.join(__dirname, 'public');
const GENERATED_DIR = IS_VERCEL
  ? path.join(os.tmpdir(), 'auralis-generated')
  : path.join(PUBLIC_DIR, 'generated');
try {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
} catch {
  /* read-only hosting: generated files are returned as data URLs instead */
}
const BODY_LIMIT = 6 * 1024 * 1024;
const REQUEST_DEADLINE = IS_VERCEL ? 52000 : 150000;

const PROVIDERS = {
  free: {
    baseUrl: 'https://blockrun.ai/api/v1',
    envKey: '',
    label: 'Lumio Free',
    protocol: 'openai',
    requiresKey: false,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: process.env.OPENROUTER_API_KEY || '',
    label: 'OpenRouter',
    protocol: 'openai',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '',
    label: 'Anthropic',
    protocol: 'anthropic',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey:
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      '',
    label: 'Gemini',
    protocol: 'openai',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    envKey: process.env.OPENAI_API_KEY || '',
    label: 'OpenAI',
    protocol: 'openai',
  },
  custom: {
    baseUrl: '',
    envKey: process.env.AI_API_KEY || '',
    label: 'Custom',
    protocol: 'openai',
  },
};

const DEFAULT_SYSTEM_PROMPT = [
  'Ты — Lumio, умный, дружелюбный и точный ИИ-ассистент.',
  'Отвечай на языке пользователя (по умолчанию — на русском).',
  'Главное правило: следуй именно тому, что написал пользователь. Не подменяй его запрос шаблоном, не отвечай заготовкой и не игнорируй детали.',
  'Будь конкретным и полезным: структурируй ответ, используй markdown, списки и короткие абзацы, если это помогает.',
  'Не добавляй воду и не повторяй вопрос. Если чего-то не знаешь — честно скажи.',
  'Код оформляй в блоки с указанием языка.',
  'Ты можешь ошибаться, но не выдумывай факты и источники.',
].join(' ');

const SITE_FREE_MODEL = 'nvidia/nemotron-3.5-bolt';

const SITE_SYSTEM_PROMPT = [
  'Ты — Lumio Site Builder, сильный веб-дизайнер и фронтенд-разработчик.',
  'Создай законченный одностраничный сайт на русском языке строго по описанию пользователя.',
  'Не используй универсальный шаблон и не подменяй запрос своим примером: название, ниша, разделы, тексты, цвета и настроение должны быть выведены из промпта.',
  'Если пользователь просит конкретные блоки (меню, тарифы, отзывы, галерею, форму), обязательно включи их.',
  'Верни ТОЛЬКО полный HTML-документ, начиная с <!DOCTYPE html> и заканчивая </html>.',
  'Без markdown-ограждений, без комментариев и текста до или после документа.',
  'Используй inline <style> и, если нужны интерактив или анимации при скролле, inline <script>.',
  'Никаких внешних JS-библиотек и сборщиков. Можно подключить Google Fonts и изображения Unsplash по прямым https-ссылкам.',
  'Дизайн должен быть современным, дорогим и адаптивным: продуманная типографика, воздух, аккуратная сетка, состояния наведения, плавные анимации и мобильная версия.',
  'Обязательно добавь <meta name="viewport" content="width=device-width, initial-scale=1">, осмысленный <title> и содержательные тексты без lorem ipsum.',
  'Не используй localStorage и не пытайся обращаться к родительской странице.',
].join(' ');


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJson(req, limit = BODY_LIMIT) {
  // Vercel Node-функции могут заранее разобрать тело запроса.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return Promise.resolve(req.body);
    }
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(req.body.trim() ? JSON.parse(req.body) : {});
      } catch {
        return Promise.reject(new Error('Некорректный JSON'));
      }
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && typeof m === 'object')
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-40)
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 120000),
    }));
}

function resolveProvider(raw) {
  const name = typeof raw === 'string' && PROVIDERS[raw] ? raw : 'openrouter';
  return { name, ...PROVIDERS[name] };
}

function resolveBaseUrl(body, provider) {
  const raw = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return raw.replace(/\/+$/, '');
      }
    } catch {
      /* fall through */
    }
  }
  return provider.baseUrl.replace(/\/+$/, '');
}

function toAnthropicMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content += `\n\n${message.content}`;
    } else {
      merged.push({ role: message.role, content: message.content });
    }
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

async function pipeAnthropicStream(upstream, res) {
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handleBlock = (block) => {
    const dataLines = block
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!dataLines.length) return;

    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }

    if (
      data?.type === 'content_block_delta' &&
      data.delta?.type === 'text_delta' &&
      typeof data.delta.text === 'string' &&
      data.delta.text
    ) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: data.delta.text } }] })}\n\n`
      );
    } else if (data?.type === 'message_stop') {
      res.write('data: [DONE]\n\n');
      finished = true;
    } else if (data?.type === 'error') {
      res.write(
        `data: ${JSON.stringify({
          error: { message: data.error?.message || 'Ошибка Anthropic' },
        })}\n\n`
      );
    }
  };

  for await (const chunk of upstream.body) {
    if (res.writableEnded) return;
    buffer += decoder.decode(chunk, { stream: true });
    let separator;
    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      handleBlock(block);
    }
  }
  if (buffer.trim()) handleBlock(buffer);
  if (!finished && !res.writableEnded) res.write('data: [DONE]\n\n');
}

const FREE_MODELS = [
  'thinkingmachines/inkling-2-mini',
  'openai/gpt-6.2-astra-pro',
  'openai/gpt-6.2-sol-pro',
  'openai/gpt-6.2-astra-pro:batch',
];

// Скрытый запасной вариант, если новые модели недоступны без оплаты.
const LEGACY_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b';

const IMAGE_MODELS = [
  'recraft/recraft-v4.1-flash-v2:free',
  'microsoft/mai-image-2.7-flash',
  'openai/gpt-image-2.6-flare',
];

const FREE_CHAT_ENDPOINTS = [
  { label: 'Pollinations', url: 'https://text.pollinations.ai/openai', model: 'openai-fast', kind: 'pollinations' },
  { label: 'Pollinations', url: 'https://text.pollinations.ai/openai', model: 'openai', kind: 'pollinations' },
];

function buildFreeChain(preferredModel = '') {
  const preferred = FREE_MODELS.includes(preferredModel) ? preferredModel : FREE_MODELS[0];
  // :batch — пакетный режим, для живого чата он слишком медленный, поэтому
  // автоматически не подключается и работает только если выбран вручную.
  const rest = FREE_MODELS.filter((model) => model !== preferred && !model.endsWith(':batch'));
  const ordered = [preferred, ...rest, LEGACY_FALLBACK_MODEL];
  const blockrun = ordered.map((model) => ({
    label: `BlockRun · ${model.split('/').pop()}`,
    url: 'https://blockrun.ai/api/v1/chat/completions',
    model,
    kind: 'blockrun',
  }));
  return [...blockrun, ...FREE_CHAT_ENDPOINTS.map((endpoint) => ({ ...endpoint }))];
}


function beginSse(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  });
}

function sseContent(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

async function streamFreeFallback(
  res,
  messages,
  systemPrompt,
  reason,
  preferredModel = '',
  options = {}
) {
  beginSse(res, { 'X-Lumio-Fallback': 'free', 'X-Lumio-Free': '1' });

  const note = reason
    ? `**Lumio Free** · ${reason} Отвечает бесплатная модель — ключ не нужен.\n\n`
    : '';
  if (note) res.write(sseContent(note));

  let controller = null;
  let closed = false;
  const onClose = () => {
    closed = true;
    if (controller) controller.abort();
  };
  res.on('close', onClose);

  let wroteContent = false;
  let lastError = '';
  const longForm = Boolean(options.longForm);
  const temperature = Number.isFinite(Number(options.temperature))
    ? Math.min(1.4, Math.max(0, Number(options.temperature)))
    : 0.7;
  const maxTokens = longForm ? 16000 : 8192;
  const endpoints = buildFreeChain(preferredModel);
  const deadline =
    Date.now() +
    (IS_VERCEL ? (longForm ? 47000 : 40000) : longForm ? 145000 : 80000);

  for (const endpoint of endpoints) {
    if (closed || res.writableEnded) break;
    const remaining = deadline - Date.now();
    if (remaining < 4000) {
      lastError = 'общий лимит ожидания бесплатных моделей';
      break;
    }

    const endpointController = new AbortController();
    controller = endpointController;
    const endpointLimit =
      endpoint.kind === 'blockrun' ? (longForm ? 85000 : 45000) : longForm ? 55000 : 30000;
    const noActivityLimit = longForm ? 26000 : 16000;
    let timedOut = false;
    let idleTimedOut = false;
    let activityTimer = null;
    let sawActivity = false;

    const armActivityTimer = () => {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        if (!sawActivity && !closed && !res.writableEnded) {
          idleTimedOut = true;
          endpointController.abort();
        }
      }, Math.min(noActivityLimit, remaining));
    };
    const markActivity = () => {
      sawActivity = true;
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = null;
    };

    const timeout = setTimeout(
      () => {
        timedOut = true;
        endpointController.abort();
      },
      Math.min(endpointLimit, remaining)
    );

    try {
      const upstream = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          Origin: `http://${HOST}:${PORT}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT }, ...messages],
          temperature,
          stream: true,
          max_tokens: maxTokens,
        }),
        signal: endpointController.signal,
      });

      if (!upstream.ok) {
        let detail = '';
        try {
          const raw = await upstream.text();
          const parsed = JSON.parse(raw);
          detail = parsed?.error?.message || parsed?.message || '';
        } catch {
          /* ignore */
        }
        lastError = `${endpoint.label}: ${upstream.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`;
        console.warn('[free fallback]', lastError);
        clearTimeout(timeout);
        if (activityTimer) clearTimeout(activityTimer);
        continue;
      }

      const type = upstream.headers.get('content-type') || '';
      if (!type.includes('text/event-stream') && !type.includes('application/json')) {
        lastError = `${endpoint.label}: неожиданный формат ответа`;
        clearTimeout(timeout);
        if (activityTimer) clearTimeout(activityTimer);
        continue;
      }

      armActivityTimer();

      if (type.includes('application/json')) {
        const data = await upstream.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) {
          markActivity();
          res.write(sseContent(text));
          wroteContent = true;
        } else {
          lastError = `${endpoint.label}: пустой ответ`;
          console.warn('[free fallback]', lastError);
          clearTimeout(timeout);
          if (activityTimer) clearTimeout(activityTimer);
          continue;
        }
      } else {
        const decoder = new TextDecoder();
        let buffer = '';
        let endpointFailed = false;

        const handleLine = (rawLine) => {
          const line = rawLine.replace(/\r$/, '');
          if (!line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            return;
          }
          if (data?.error) {
            endpointFailed = true;
            lastError = `${endpoint.label}: ${data.error.message || 'ошибка модели'}`;
            return;
          }
          const delta = data?.choices?.[0]?.delta;
          if (!delta) return;
          if (
            typeof delta.reasoning_content === 'string' ||
            typeof delta.reasoning === 'string' ||
            typeof delta.content === 'string'
          ) {
            markActivity();
          }
          // Reasoning-модели (Nemotron и другие) сначала стримят размышления.
          // Это не ответ пользователю, но это признак, что запрос жив.
          if (typeof delta.content === 'string' && delta.content) {
            wroteContent = true;
            res.write(sseContent(delta.content));
          }
        };

        for await (const chunk of upstream.body) {
          if (closed || res.writableEnded || endpointFailed) break;
          buffer += decoder.decode(chunk, { stream: true });
          let lineEnd;
          while ((lineEnd = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, lineEnd));
            buffer = buffer.slice(lineEnd + 1);
            if (endpointFailed) break;
          }
          if (endpointFailed) break;
        }
        if (!endpointFailed && buffer.trim()) handleLine(buffer);
        clearTimeout(timeout);
        if (activityTimer) clearTimeout(activityTimer);
        if (endpointFailed) {
          console.warn('[free fallback]', lastError);
          if (wroteContent) break;
          continue;
        }
      }

      clearTimeout(timeout);
      if (activityTimer) clearTimeout(activityTimer);
      if (!wroteContent) {
        lastError = `${endpoint.label}: модель не выдала ответ`;
        console.warn('[free fallback]', lastError);
        continue;
      }
      if (!closed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
      res.removeListener('close', onClose);
      return;
    } catch (error) {
      clearTimeout(timeout);
      if (activityTimer) clearTimeout(activityTimer);
      if (closed || res.writableEnded) {
        res.removeListener('close', onClose);
        return;
      }
      lastError = `${endpoint.label}: ${
        idleTimedOut
          ? 'нет ответа от модели'
          : timedOut || error?.name === 'AbortError'
            ? 'таймаут'
            : error?.message || 'ошибка'
      }`;
      console.warn('[free fallback]', lastError);
      if (wroteContent) break;
    }
  }

  if (closed || res.writableEnded) {
    res.removeListener('close', onClose);
    return;
  }

  const tail = wroteContent
    ? '\n\n_Ответ бесплатной модели прервался. Попробуйте повторить запрос._\n\n'
    : `\n\n**Lumio Free временно недоступен.** Показываю локальный ответ. Детали: ${lastError || 'сеть'}\n\n`;
  res.write(sseContent(tail));

  if (wroteContent) {
    res.write('data: [DONE]\n\n');
    res.end();
    res.removeListener('close', onClose);
    return;
  }

  streamDemo(res, demoReply(messages));
  res.removeListener('close', onClose);
}


async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const messages = normalizeMessages(body.messages);
  if (!messages.length) {
    return sendJson(res, 400, { error: 'Нет сообщений для отправки' });
  }

  const provider = resolveProvider(body.provider);
  const baseUrl = resolveBaseUrl(body, provider);
  const model = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : '';
  if (!model) {
    return sendJson(res, 400, { error: 'Не выбрана модель. Откройте настройки.' });
  }
  if (!baseUrl) {
    return sendJson(res, 400, { error: 'Укажите Base URL вашего API в настройках.' });
  }

  const clientKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = clientKey || provider.envKey;
  const needsKey = provider.requiresKey !== false && provider.name !== 'custom';

  const temperature = Number.isFinite(Number(body.temperature))
    ? Math.min(2, Math.max(0, Number(body.temperature)))
    : 0.7;
  const systemPrompt =
    typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
      ? body.systemPrompt.trim().slice(0, 12000)
      : DEFAULT_SYSTEM_PROMPT;

  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const longForm = /html|сайт|лендинг|веб[- ]страниц|сверстай|landing page|full website/i.test(
    `${systemPrompt} ${lastUserText}`
  );
  const chatOptions = { temperature, longForm };

  if (provider.name === 'free') {
    return streamFreeFallback(res, messages, systemPrompt, '', model, chatOptions);
  }

  if (needsKey && !apiKey) {
    return streamFreeFallback(
      res,
      messages,
      systemPrompt,
      `Ключ ${provider.label} не указан.`,
      '',
      chatOptions
    );
  }

  const isAnthropic = provider.protocol === 'anthropic';
  const payload = isAnthropic
    ? {
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: toAnthropicMessages(messages),
        temperature: Math.min(1, temperature),
        stream: true,
      }
    : {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature,
        max_tokens: longForm ? 16000 : 8192,
        stream: true,
      };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (isAnthropic) {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider.name === 'openrouter') {
    headers['HTTP-Referer'] = `http://${HOST}:${PORT}`;
    headers['X-Title'] = 'Lumio';
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 180000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  try {
    const upstream = await fetch(`${baseUrl}${isAnthropic ? '/messages' : '/chat/completions'}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      clearTimeout(timeout);
      res.removeListener('close', onClose);
      let message = `Провайдер ответил ошибкой ${upstream.status}`;
      try {
        const text = await upstream.text();
        try {
          const parsed = JSON.parse(text);
          message = parsed?.error?.message || parsed?.message || message;
        } catch {
          if (text && text.length < 500) message = text;
        }
      } catch {
        /* ignore */
      }
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      const reason =
        upstream.status === 401 || upstream.status === 403
          ? `Ключ ${provider.label} не принят.`
          : upstream.status === 429
            ? `Лимит ${provider.label} исчерпан.`
            : `${provider.label} временно недоступен (${upstream.status}).`;
      console.warn(`[chat fallback] ${provider.label}: ${status} ${message}`);
      return streamFreeFallback(res, messages, systemPrompt, reason, '', chatOptions);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    console.log(`[chat] ${provider.label} · ${model} · ${messages.length} сообщ.`);

    if (isAnthropic) {
      await pipeAnthropicStream(upstream, res);
      if (!res.writableEnded) res.end();
    } else {
      for await (const chunk of upstream.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
      res.end();
    }
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;

    if (error && error.name === 'AbortError') {
      if (!res.headersSent) {
        return streamFreeFallback(
          res,
          messages,
          systemPrompt,
          timedOut
            ? `${provider.label} не ответил вовремя.`
            : `Запрос к ${provider.label} отменён.`,
          '',
          chatOptions
        );
      }
      if (!res.writableEnded) {
        res.write(sseContent('\n\n_Ответ прерван._\n\n'));
        res.end();
      }
      return;
    }

    const cause = error && error.cause ? error.cause.code : '';
    let message = `${provider.label} недоступен.`;
    if (cause === 'ECONNREFUSED') {
      message = `Не удалось подключиться к ${provider.label}. Проверьте Base URL.`;
    } else if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
      message = `Не удалось найти сервер ${provider.label}. Проверьте подключение к интернету.`;
    }
    console.error('[chat error]', (error && error.message) || error, cause ? `(${cause})` : '');

    if (!res.headersSent) {
      return streamFreeFallback(res, messages, systemPrompt, message, '', chatOptions);
    }
    if (!res.writableEnded) {
      res.write(sseContent('\n\n_Соединение с моделью прервалось. Попробуйте ещё раз._\n\n'));
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', onClose);
  }
}

async function completeFreeText(messages, systemPrompt, options = {}) {
  const temperature = Number.isFinite(Number(options.temperature))
    ? Math.min(1.4, Math.max(0, Number(options.temperature)))
    : 0.7;
  const maxTokens = Number(options.maxTokens) || 8192;
  const deadline =
    Date.now() +
    Math.min(
      Number(options.deadlineMs) || (IS_VERCEL ? 48000 : 110000),
      IS_VERCEL ? 50000 : 150000
    );
  const preferred = options.preferredModel || '';
  const failures = [];

  for (const endpoint of buildFreeChain(preferred)) {
    const remaining = deadline - Date.now();
    if (remaining < 3500) break;
    const perEndpoint =
      Number(options.endpointTimeoutMs) ||
      (endpoint.kind === 'blockrun' ? 28000 : 22000);
    const timeout = Math.min(remaining, perEndpoint);
    const requestStarted = Date.now();
    try {
      console.log(
        `[free complete] → ${endpoint.label} · max ${maxTokens} · timeout ${Math.round(timeout / 1000)}s · prompt ${systemPrompt.length + (messages[0]?.content?.length || 0)}`
      );
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: `http://${HOST}:${PORT}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          temperature,
          stream: false,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        let detail = '';
        try {
          const raw = await response.text();
          const parsed = JSON.parse(raw);
          detail = parsed?.error?.message || parsed?.message || '';
        } catch {
          /* ignore */
        }
        failures.push(`${endpoint.label}: ${response.status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`);
        console.warn('[free complete]', failures[failures.length - 1]);
        continue;
      }
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) {
        console.log(
          `[free complete] ✓ ${endpoint.label} · ${((Date.now() - requestStarted) / 1000).toFixed(1)}s · ${text.length} символов`
        );
        return { text, model: endpoint.model, endpoint: endpoint.label };
      }
      failures.push(`${endpoint.label}: пустой ответ`);
    } catch (error) {
      failures.push(
        `${endpoint.label}: ${
          error?.name === 'TimeoutError' ? 'таймаут' : error?.message || 'сеть'
        }`
      );
      console.warn(
        '[free complete]',
        failures[failures.length - 1],
        `${((Date.now() - requestStarted) / 1000).toFixed(1)}s`
      );
    }
  }

  throw new Error(failures.slice(-3).join(' · ') || 'Бесплатные модели не ответили');
}

async function completeProviderText({
  provider,
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  messages,
  temperature,
  maxTokens,
  deadlineMs,
  endpointTimeoutMs,
}) {
  if (provider.name === 'free') {
    return completeFreeText(messages, systemPrompt, {
      temperature,
      maxTokens,
      preferredModel: model,
      deadlineMs,
      endpointTimeoutMs,
    });
  }

  const isAnthropic = provider.protocol === 'anthropic';
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (isAnthropic) {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider.name === 'openrouter') {
    headers['HTTP-Referer'] = `http://${HOST}:${PORT}`;
    headers['X-Title'] = 'Lumio';
  }

  const payload = isAnthropic
    ? {
        model,
        max_tokens: Math.min(8192, maxTokens || 8192),
        system: systemPrompt,
        messages: toAnthropicMessages(messages),
        temperature: Math.min(1, Number(temperature) || 0.7),
      }
    : {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: Number(temperature) || 0.7,
        max_tokens: maxTokens || 8192,
      };

  const response = await fetch(
    `${baseUrl}${isAnthropic ? '/messages' : '/chat/completions'}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(
        Math.min(Number(deadlineMs) || (IS_VERCEL ? 48000 : 120000), IS_VERCEL ? 50000 : 150000)
      ),
    }
  );
  if (!response.ok) {
    let detail = '';
    try {
      const raw = await response.text();
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || parsed?.message || '';
    } catch {
      /* ignore */
    }
    throw new Error(`${provider.label}: ${response.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
  }
  const data = await response.json();
  const text = isAnthropic
    ? (data?.content || [])
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    : data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${provider.label}: пустой ответ`);
  }
  return { text, model, endpoint: provider.label };
}

function extractHtmlDocument(text) {
  let source = String(text || '').trim();
  if (!source) return null;
  const fence = source.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) source = fence[1].trim();
  const start = source.search(/<!DOCTYPE html|<html[\s>]/i);
  if (start > 0) source = source.slice(start);
  const end = source.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) source = source.slice(0, end + 7);
  if (!/<html[\s>]/i.test(source)) return null;
  if (!/<\/html>/i.test(source)) {
    if (/<style[\s>]/i.test(source) && !/<\/style>/i.test(source)) source += '\n</style>';
    if (/<script[\s>]/i.test(source) && !/<\/script>/i.test(source)) source += '\n</script>';
    if (!/<\/body>/i.test(source)) source += '\n</body>';
    source += '\n</html>';
  }
  return source.trim();
}

const SITE_STYLE_LABELS_SERVER = {
  dark: 'тёмный минимализм, глубокий фон, выразительные акценты',
  light: 'светлый воздушный дизайн, мягкие тени, аккуратная типографика',
  neon: 'неон, киберпанк, свечение, контрастные акценты',
  glass: 'стеклянные карточки, размытие, глубина, современный градиент',
  minimal: 'строгий минимализм, много воздуха, крупная типографика',
};

function sitePromptScore(prompt, html) {
  const stop = new Set([
    'сайт', 'лендинг', 'страница', 'сделай', 'создай', 'собери', 'сверстай',
    'для', 'про', 'что', 'чтобы', 'это', 'как', 'или', 'если', 'нужно',
    'красивый', 'современный', 'который', 'очень', 'стиль', 'дизайн',
  ]);
  const words = String(prompt || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stop.has(word));
  if (!words.length) return 1;
  const haystack = String(html || '').toLowerCase();
  const hits = words.filter((word) => haystack.includes(word.slice(0, Math.max(4, word.length - 2))));
  return hits.length / words.length;
}

async function handleSiteGenerate(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 1200) : '';
  if (!prompt) return sendJson(res, 400, { error: 'Опишите сайт' });

  const style = typeof body.style === 'string' ? body.style.slice(0, 40) : 'dark';
  const styleLabel = SITE_STYLE_LABELS_SERVER[style] || 'современный премиальный дизайн';
  const provider = resolveProvider(body.provider || 'free');
  const baseUrl = resolveBaseUrl(body, provider);
  const requestedModel =
    (typeof body.model === 'string' && body.model.trim()) || '';
  const model =
    provider.name === 'free' ? SITE_FREE_MODEL : requestedModel;
  const clientKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = clientKey || provider.envKey;
  const temperature = Number.isFinite(Number(body.temperature))
    ? Math.min(1.3, Math.max(0.4, Number(body.temperature)))
    : 0.8;

  if (!provider.baseUrl && !baseUrl) {
    return sendJson(res, 400, { error: 'Укажите Base URL API' });
  }
  if (provider.name !== 'free' && provider.name !== 'custom' && !apiKey) {
    return sendJson(res, 400, { error: `Нет ключа ${provider.label}` });
  }
  if (provider.name !== 'free' && !model) {
    return sendJson(res, 400, { error: 'Не выбрана модель' });
  }

  const systemPrompt = `${SITE_SYSTEM_PROMPT} Визуальный стиль: ${styleLabel}.`;
  const userContent = [
    `Описание от пользователя (это главный источник истины): ${prompt}`,
    `Визуальный стиль: ${styleLabel}.`,
    'Сделай несколько полноценных секций: первый экран, преимущества или услуги, галерея/примеры, финальный призыв к действию и футер.',
    'Если в описании есть конкретные разделы, названия, цены, меню, отзывы, контакты или формы — включи именно их.',
    'Не используй универсальные заглушки и не заменяй нишу пользователя другой нишей.',
    'Добавь заметный визуальный акцент на первом экране и 2–4 деликатные анимации. Сайт должен выглядеть как работа топовой студии.',
  ].join('\n');

  const messages = [{ role: 'user', content: userContent }];
  const started = Date.now();
  const overallDeadline = started + (IS_VERCEL ? 50000 : 100000);
  let lastError = '';
  let html = null;
  let usedModel = model;
  let usedEndpoint = provider.label;

  let best = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (best && best.score >= 0.5) break;
    const remaining = overallDeadline - Date.now();
    if (remaining < 12000) break;
    const retryNote = !best
      ? attempt === 0
        ? ''
        : ' ВАЖНО: предыдущая попытка не дала HTML. Верни только документ, строго по описанию пользователя.'
      : ' ВАЖНО: прошлый сайт не повторял описание. Используй названия, разделы, цены и цвета из описания дословно, без шаблонных заглушек.';
    try {
      const result = await completeProviderText({
        provider,
        apiKey,
        baseUrl,
        model,
        systemPrompt: `${systemPrompt}${retryNote}`,
        messages,
        temperature: attempt === 0 ? temperature : Math.min(1, temperature + 0.1),
        maxTokens: 9000,
        deadlineMs: Math.min(remaining, IS_VERCEL ? 45000 : 80000),
        endpointTimeoutMs: IS_VERCEL ? 38000 : 45000,
      });
      const candidate = extractHtmlDocument(result.text);
      if (!candidate) {
        lastError = 'Модель вернула текст без HTML-документа';
        continue;
      }
      const score = sitePromptScore(prompt, candidate);
      if (!best || score > best.score) {
        best = { html: candidate, score, model: result.model, endpoint: result.endpoint };
      }
    } catch (error) {
      lastError = error?.message || 'Модель не ответила';
      console.warn('[site]', lastError);
      if (provider.name !== 'free') break;
    }
  }
  if (best) {
    html = best.html;
    usedModel = best.model;
    usedEndpoint = best.endpoint;
  }

  if (!html) {
    return sendJson(res, 502, {
      error: lastError || 'Не удалось собрать сайт',
      fallback: true,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }

  const adherence = sitePromptScore(prompt, html);
  return sendJson(res, 200, {
    html,
    source: 'model',
    model: usedModel,
    endpoint: usedEndpoint,
    prompt,
    style,
    adherence,
    fallback: false,
    seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
  });
}

async function handleModels(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const provider = resolveProvider(body.provider);
  const baseUrl = resolveBaseUrl(body, provider);
  const apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) || provider.envKey;

  if (!baseUrl) {
    return sendJson(res, 400, { error: 'Укажите Base URL API' });
  }

  const headers = { Accept: 'application/json' };
  if (provider.protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider.name === 'openrouter') {
    headers['HTTP-Referer'] = `http://${HOST}:${PORT}`;
    headers['X-Title'] = 'Lumio';
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      let message = `Не удалось получить модели (${response.status})`;
      try {
        const data = await response.json();
        message = data?.error?.message || data?.message || message;
      } catch {
        /* ignore */
      }
      return sendJson(res, response.status === 401 ? 401 : 502, { error: message });
    }
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const freeOnly = provider.name === 'free';
    const models = list
      .filter(
        (m) =>
          m &&
          typeof m.id === 'string' &&
          (!freeOnly || (m.billing_mode === 'free' && m.available !== false))
      )
      .map((m) => ({
        id: m.id.slice(0, 220),
        name:
          typeof m.display_name === 'string'
            ? m.display_name.slice(0, 220)
            : typeof m.name === 'string'
              ? m.name.slice(0, 220)
              : m.id.split('/').pop(),
        context: Number(m.context_window || m.context_length) || null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 600);
    return sendJson(res, 200, { models });
  } catch (error) {
    const message =
      error?.name === 'TimeoutError'
        ? 'Провайдер не ответил за 30 секунд'
        : error?.message || 'Ошибка сети';
    return sendJson(res, 502, { error: message });
  }
}

const IMAGE_SIZES = new Set([512, 720, 768, 1024, 1280]);

function clampImageSize(raw, fallback) {
  const value = Number.parseInt(raw, 10);
  return IMAGE_SIZES.has(value) ? value : fallback;
}

const IMAGE_FALLBACK_WAIT = 12;
let imageAllowedAt = 0;
let imageInFlight = false;
const translationCache = new Map();

function imageCooldownRemaining() {
  return Math.max(0, Math.ceil((imageAllowedAt - Date.now()) / 1000));
}

function buildFullImagePrompt(prompt, style) {
  return `${prompt}. ${
    style ? `${style}. ` : ''
  }Professional composition, beautiful lighting, high detail.`;
}

function buildImageTarget({ prompt, style, width, height, seed }) {
  const target = new URL(
    `https://image.pollinations.ai/prompt/${encodeURIComponent(
      buildFullImagePrompt(prompt, style)
    )}`
  );
  target.searchParams.set('width', String(width));
  target.searchParams.set('height', String(height));
  target.searchParams.set('seed', String(seed));
  target.searchParams.set('model', 'flux');
  target.searchParams.set('nologo', 'true');
  return target;
}

async function parseImageFailure(upstream) {
  let raw = '';
  try {
    raw = await upstream.text();
  } catch {
    /* ignore */
  }
  let message = '';
  try {
    const data = JSON.parse(raw);
    const rawMessage = data?.error?.message || data?.error || data?.message || '';
    if (typeof rawMessage === 'string') message = rawMessage;
  } catch {
    /* ignore */
  }
  const headerRetry = Number.parseInt(
    upstream.headers.get('retry-after') ||
      upstream.headers.get('ratelimit-reset') ||
      upstream.headers.get('x-ratelimit-reset') ||
      '',
    10
  );
  return {
    message: message.slice(0, 300),
    retryAfter: Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : 0,
  };
}

function latinTranslation(value) {
  const text = String(value || '').trim().replace(/^["'«]+|["'»]+$/g, '');
  if (!text || /[А-Яа-яЁё]/.test(text) || !/[A-Za-z]/.test(text)) return '';
  return text.slice(0, 900);
}

async function googleTranslatePrompt(prompt) {
  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', 'en');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', prompt);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Lumio/1.0 (local AI workspace)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return '';
    const data = await response.json();
    const translated = Array.isArray(data?.[0])
      ? data[0]
          .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
          .join('')
          .trim()
      : '';
    return latinTranslation(translated);
  } catch {
    return '';
  }
}

async function myMemoryTranslatePrompt(prompt) {
  try {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', prompt.slice(0, 450));
    url.searchParams.set('langpair', 'ru|en');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return '';
    const data = await response.json();
    return latinTranslation(data?.responseData?.translatedText);
  } catch {
    return '';
  }
}

async function modelTranslatePrompt(prompt) {
  try {
    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: 'openai-fast',
        messages: [
          {
            role: 'system',
            content:
              'Translate the Russian image prompt into natural English. Return only the English translation, without quotes, comments or explanations.',
          },
          { role: 'user', content: prompt.slice(0, 900) },
        ],
        temperature: 0,
        stream: false,
        max_tokens: 220,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return '';
    const data = await response.json();
    return latinTranslation(data?.choices?.[0]?.message?.content);
  } catch {
    return '';
  }
}

async function translatePrompt(prompt) {
  if (!/[А-Яа-яЁё]/.test(prompt)) return prompt;
  const cached = translationCache.get(prompt);
  if (cached) return cached;

  const translated =
    (await googleTranslatePrompt(prompt)) ||
    (await myMemoryTranslatePrompt(prompt)) ||
    (await modelTranslatePrompt(prompt));
  if (!translated) return prompt;
  if (translationCache.size > 100) translationCache.clear();
  translationCache.set(prompt, translated);
  return translated;
}

async function fetchGatewayImage({ prompt, width, height, model }) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const key = process.env.BLOCKRUN_API_KEY || process.env.IMAGE_API_KEY || '';
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const upstream = await fetch('https://blockrun.ai/api/v1/images/generations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, prompt, n: 1, size: `${width}x${height}` }),
      signal: AbortSignal.timeout(IS_VERCEL ? 22000 : 55000),
    });
    if (!upstream.ok) {
      console.warn(`[image] ${model} ${upstream.status}`);
      return { error: model, retryAfter: 5 };
    }
    const data = await upstream.json();
    const item = data?.data?.[0] || {};
    let buffer = null;
    let contentType = 'image/png';
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(20000) });
      contentType = img.headers.get('content-type') || 'image/png';
      if (!img.ok || !contentType.startsWith('image/')) return { error: model, retryAfter: 5 };
      buffer = Buffer.from(await img.arrayBuffer());
    }
    if (!buffer || buffer.length < 1000 || buffer.length > 15 * 1024 * 1024) {
      return { error: model, retryAfter: 5 };
    }
    return { buffer, contentType, source: model.split('/').pop(), externalUrl: item.url || '', retryAfter: 0 };
  } catch (error) {
    console.warn('[image]', model, error?.message || error);
    return { error: model, retryAfter: 5 };
  }
}

async function fetchPollinationsImage({ prompt, style, width, height, seed }) {
  const target = buildImageTarget({ prompt, style, width, height, seed });
  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*',
        'User-Agent': 'Lumio/1.0 (local AI workspace)',
      },
      signal: AbortSignal.timeout(IS_VERCEL ? 42000 : 65000),
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      const failure = await parseImageFailure(upstream);
      const retryAfter =
        failure.retryAfter ||
        (upstream.status === 402 || upstream.status === 429 ? 45 : 10);
      console.error(
        `[image] Pollinations ${upstream.status} ${contentType}${
          failure.message ? ` — ${failure.message}` : ''
        }`
      );
      return { error: 'Pollinations', retryAfter };
    }

    const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10);
    if (Number.isFinite(contentLength) && contentLength > 15 * 1024 * 1024) {
      return { error: 'Слишком большое изображение', retryAfter: 5 };
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length < 1000 || buffer.length > 15 * 1024 * 1024) {
      return { error: 'Пустое изображение', retryAfter: 5 };
    }
    return {
      buffer,
      contentType,
      source: 'Pollinations',
      externalUrl: target.toString(),
      retryAfter: 0,
    };
  } catch (error) {
    console.error('[image] Pollinations', error?.message || error);
    return {
      error: error?.name === 'TimeoutError' ? 'Таймаут' : 'Сеть',
      retryAfter: 8,
    };
  }
}

function hordeImageSize(width, height) {
  const maxSide = 704;
  const minSide = 256;
  const ratio = width / height;
  let h = Math.max(minSide, Math.round(height / 64) * 64);
  let w = Math.max(minSide, Math.round((h * ratio) / 64) * 64);
  if (w > maxSide) {
    w = maxSide;
    h = Math.max(minSide, Math.round(w / ratio / 64) * 64);
  }
  if (h > maxSide) {
    h = maxSide;
    w = Math.max(minSide, Math.round(h * ratio / 64) * 64);
  }
  return {
    width: Math.min(maxSide, w),
    height: Math.min(maxSide, h),
  };
}

async function fetchStableHordeImage({ prompt, style, width, height, seed }) {
  const base = 'https://stablehorde.net/api/v2';
  const size = hordeImageSize(width, height);
  const headers = {
    'Content-Type': 'application/json',
    'Client-Agent': 'Lumio:2.0:(local)',
    apikey: '0000000000',
  };

  try {
    const submit = await fetch(`${base}/generate/async`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        prompt: buildFullImagePrompt(prompt, style),
        params: {
          width: size.width,
          height: size.height,
          steps: 28,
          cfg_scale: 7,
          sampler_name: 'k_euler',
          n: 1,
          karras: true,
          seed: String(seed),
        },
        negative_prompt:
          'watermark, text, logo, low quality, blurry, deformed, ugly, extra limbs, bad anatomy',
        nsfw: false,
        censor_nsfw: true,
        models: [
          'Juggernaut XL',
          'Dreamshaper',
          'Realistic Vision',
          'Deliberate',
          "ICBINP - I Can't Believe It's Not Photography",
          'stable_diffusion',
        ],
        r2: true,
        shared: false,
      }),
    });

    if (!submit.ok) {
      let detail = '';
      try {
        const data = await submit.json();
        detail = data?.message || data?.errors ? JSON.stringify(data.errors || data.message) : '';
      } catch {
        /* ignore */
      }
      console.error('[image] Stable Horde submit', submit.status, detail.slice(0, 200));
      return {
        error: `Stable Horde: ${submit.status}`,
        retryAfter: submit.status === 403 ? 40 : 15,
      };
    }

    const job = await submit.json();
    const id = typeof job?.id === 'string' ? job.id : '';
    if (!id) return { error: 'Stable Horde: нет задания', retryAfter: 15 };

    const deadline = Date.now() + 70000;
    let lastCheck = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      let check;
      try {
        check = await fetch(`${base}/generate/check/${encodeURIComponent(id)}`, {
          headers: { 'Client-Agent': headers['Client-Agent'] },
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        console.error('[image] Stable Horde check', error?.message || error);
        continue;
      }
      if (!check.ok) continue;
      let state;
      try {
        state = await check.json();
      } catch {
        continue;
      }
      lastCheck = state;
      if (state?.faulted) {
        return { error: 'Stable Horde: задание отклонено', retryAfter: 20 };
      }
      if (state?.is_possible === false) {
        return { error: 'Stable Horde: нет доступных воркеров', retryAfter: 30 };
      }
      if (!state?.done) continue;

      const status = await fetch(`${base}/generate/status/${encodeURIComponent(id)}`, {
        headers: { 'Client-Agent': headers['Client-Agent'] },
        signal: AbortSignal.timeout(20000),
      });
      if (!status.ok) return { error: `Stable Horde: ${status.status}`, retryAfter: 20 };
      const result = await status.json();
      const generation = result?.generations?.[0];
      if (!generation || generation.censored) {
        return { error: 'Stable Horde: изображение скрыто фильтром', retryAfter: 25 };
      }
      const imageUrl = generation.img || generation.url;
      if (!imageUrl) return { error: 'Stable Horde: нет ссылки на картинку', retryAfter: 20 };

      const image = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Lumio/1.0 (local AI workspace)' },
        signal: AbortSignal.timeout(45000),
      });
      const contentType = image.headers.get('content-type') || '';
      if (!image.ok || !contentType.startsWith('image/')) {
        return { error: 'Stable Horde: не удалось скачать картинку', retryAfter: 20 };
      }
      const buffer = Buffer.from(await image.arrayBuffer());
      if (buffer.length < 1000 || buffer.length > 15 * 1024 * 1024) {
        return { error: 'Stable Horde: пустая картинка', retryAfter: 15 };
      }
      return {
        buffer,
        contentType,
        source: 'Stable Horde',
        width: size.width,
        height: size.height,
        retryAfter: 0,
      };
    }

    const queue = Number(lastCheck?.queue_position);
    console.error('[image] Stable Horde timeout', Number.isFinite(queue) ? `queue ${queue}` : '');
    return { error: 'Stable Horde: очередь', retryAfter: 25 };
  } catch (error) {
    console.error('[image] Stable Horde', error?.message || error);
    return {
      error: error?.name === 'TimeoutError' ? 'Stable Horde: таймаут' : 'Stable Horde: сеть',
      retryAfter: 15,
    };
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function localImageTheme(prompt) {
  const text = String(prompt).toLowerCase();
  const flags = {
    space: /космос|космич|space|планет|saturn|сатурн|звезд|galaxy|galaxy|astronaut|космонавт|вселен|nebul|марс|луна/.test(text),
    cat: /кот|cat|кошк|котён|kitten|тигр|tiger|лев|lion/.test(text),
    coffee: /кофе|coffee|капучино|латте|эспрессо|cafe|бариста/.test(text),
    mountain: /гор|mountain|курорт|travel|путешеств|лес|forest|поход|альп/.test(text),
    ocean: /море|океан|ocean|волн|beach|пляж|остров|island|серф/.test(text),
    city: /город|city|tokyo|токио|улиц|street|небоскр|skyline/.test(text),
    food: /еда|food|пицц|бургер|ресторан|десерт|торт|cake|food/.test(text),
    flower: /цвет|flower|сад|garden|растен|ботаник/.test(text),
  };
  return flags;
}

function localImagePalette(prompt, style) {
  const text = `${prompt} ${style}`.toLowerCase();
  const colorWords = [
    [/(?<![а-яё])(красн|алый|\bred\b)/, ['#2a0a0c', '#1a0508', '#ff3b3b', '#ffb199']],
    [/(?<![а-яё])(син|голуб|\bblue\b)/, ['#07122b', '#0a1d45', '#4f8cff', '#7fe0ff']],
    [/(?<![а-яё])(зел[её]н|\bgreen\b)/, ['#06190f', '#0c2a1a', '#3be08a', '#c8ff9a']],
    [/(?<![а-яё])(розов|\bpink\b)/, ['#2a0a1c', '#3d1230', '#ff5fa2', '#ffc2e0']],
    [/(?<![а-яё])(жёлт|желт|золот|\byellow\b|\bgold\b)/, ['#1f1604', '#2e2108', '#ffc93c', '#fff0b3']],
    [/(?<![а-яё])(фиолет|пурпур|\bpurple\b)/, ['#12082b', '#22104a', '#9d6bff', '#e0c7ff']],
  ];
  for (const [re, c] of colorWords) {
    if (re.test(text)) return { bg1: c[0], bg2: c[1], accent: c[2], accent2: c[3], soft: c[2], text: '#fff8ee' };
  }
  if (/neon|неон|cyber|кибер/.test(text)) {
    return { bg1: '#070b1c', bg2: '#1b0c2e', accent: '#28f0d0', accent2: '#ff3fa4', soft: '#8f7bff', text: '#f4f2ff' };
  }
  if (/anime|аниме|manga|манга/.test(text)) {
    return { bg1: '#131a3a', bg2: '#3b1d54', accent: '#ffd166', accent2: '#ff6b9e', soft: '#7bdff2', text: '#fff8f2' };
  }
  if (/minimal|минимал|\blight\b|светл/.test(text)) {
    return { bg1: '#f3efe7', bg2: '#dfe8e2', accent: '#1f4d46', accent2: '#c56b4a', soft: '#8fb3a5', text: '#17211e' };
  }
  if (/3d|render|объ[её]м/.test(text)) {
    return { bg1: '#0d1130', bg2: '#2d1861', accent: '#7c6cff', accent2: '#ff8a3d', soft: '#46d7ff', text: '#f7f5ff' };
  }
  if (/space|космос|космич|galaxy|планет/.test(text)) {
    return { bg1: '#040617', bg2: '#1b0b2e', accent: '#ffb347', accent2: '#ff5d8f', soft: '#76a9ff', text: '#fff5e8' };
  }
  return { bg1: '#0d1a1f', bg2: '#241511', accent: '#e8b06b', accent2: '#69a58d', soft: '#8bbfd0', text: '#fff8ee' };
}

function wrapSvgText(text, maxChars, maxLines = 4) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length ? lines : ['Lumio Vision'];
}

function buildLocalImage({ prompt, style, width, height, seed }) {
  const w = Math.max(512, Number(width) || 1024);
  const h = Math.max(512, Number(height) || 1024);
  const palette = localImagePalette(prompt, style);
  const theme = localImageTheme(prompt);
  let randomState = (Number(seed) || 7) >>> 0;
  const random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const side = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const art = [];

  // Sun / planet / halo.
  if (theme.space) {
    const planetX = w * (0.24 + random() * 0.52);
    const planetY = h * (0.22 + random() * 0.32);
    const r = side * (0.13 + random() * 0.08);
    for (let i = 0; i < 80; i += 1) {
      art.push(
        `<circle cx="${(random() * w).toFixed(1)}" cy="${(random() * h * 0.75).toFixed(1)}" r="${(0.6 + random() * 1.8).toFixed(2)}" fill="${palette.text}" opacity="${(0.18 + random() * 0.75).toFixed(2)}"/>`
      );
    }
    art.push(`<circle cx="${planetX}" cy="${planetY}" r="${r}" fill="${palette.accent}" opacity=".92"/>`);
    art.push(
      `<ellipse cx="${planetX}" cy="${planetY}" rx="${r * 1.8}" ry="${r * 0.42}" fill="none" stroke="${palette.accent2}" stroke-width="${Math.max(2, side * 0.006)}" opacity=".8" transform="rotate(-18 ${planetX} ${planetY})"/>`
    );
    art.push(
      `<circle cx="${w * 0.82}" cy="${h * 0.2}" r="${side * 0.08}" fill="${palette.soft}" opacity=".35"/>`
    );
    art.push(
      `<path d="M ${w * 0.08} ${h * 0.62} Q ${w * 0.34} ${h * 0.44} ${w * 0.62} ${h * 0.58}" fill="none" stroke="${palette.soft}" stroke-width="${side * 0.008}" opacity=".45"/>`
    );
  } else {
    art.push(
      `<circle cx="${w * 0.74}" cy="${h * 0.25}" r="${side * 0.2}" fill="${palette.accent}" opacity=".18"/>`
    );
    art.push(
      `<circle cx="${w * 0.74}" cy="${h * 0.25}" r="${side * 0.12}" fill="${palette.accent}" opacity=".72"/>`
    );
    art.push(
      `<circle cx="${w * 0.18}" cy="${h * 0.38}" r="${side * 0.24}" fill="${palette.accent2}" opacity=".14"/>`
    );
  }

  // Landscape layers.
  if (theme.mountain || theme.ocean) {
    const baseY = h * 0.72;
    if (theme.mountain) {
      art.push(
        `<path d="M 0 ${h} L 0 ${baseY + 30} L ${w * 0.2} ${baseY - side * 0.08} L ${w * 0.38} ${baseY + 22} L ${w * 0.57} ${baseY - side * 0.2} L ${w * 0.75} ${baseY + 10} L ${w} ${baseY - side * 0.06} L ${w} ${h} Z" fill="${palette.accent}" opacity=".32"/>`
      );
      art.push(
        `<path d="M 0 ${h} L 0 ${baseY + 95} L ${w * 0.28} ${baseY + 18} L ${w * 0.49} ${baseY + 100} L ${w * 0.68} ${baseY + 34} L ${w} ${baseY + 90} L ${w} ${h} Z" fill="${palette.bg1}" opacity=".72"/>`
      );
      art.push(
        `<path d="M ${w * 0.53} ${baseY - side * 0.13} L ${w * 0.57} ${baseY - side * 0.2} L ${w * 0.61} ${baseY - side * 0.12} Z" fill="${palette.text}" opacity=".62"/>`
      );
    }
    if (theme.ocean) {
      for (let i = 0; i < 5; i += 1) {
        const y = baseY + i * side * 0.035;
        art.push(
          `<path d="M 0 ${y} Q ${w * 0.18} ${y - side * 0.035} ${w * 0.36} ${y} T ${w * 0.72} ${y} T ${w} ${y}" fill="none" stroke="${i % 2 ? palette.accent2 : palette.soft}" stroke-width="${Math.max(1.5, side * 0.005)}" opacity="${0.55 - i * 0.07}"/>`
        );
      }
    }
  }

  // City silhouette.
  if (theme.city) {
    let x = 0;
    while (x < w) {
      const bw = w * (0.035 + random() * 0.055);
      const bh = h * (0.08 + random() * 0.28);
      art.push(
        `<rect x="${x.toFixed(1)}" y="${(h * 0.78 - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${palette.bg1}" opacity=".82"/>`
      );
      for (let wy = h * 0.78 - bh + 12; wy < h * 0.76; wy += 17) {
        art.push(
          `<rect x="${(x + bw * 0.22).toFixed(1)}" y="${wy.toFixed(1)}" width="${(bw * 0.16).toFixed(1)}" height="4" fill="${palette.accent}" opacity="${(0.2 + random() * 0.55).toFixed(2)}"/>`
        );
      }
      x += bw + w * 0.012;
    }
  }

  // Coffee cup.
  if (theme.coffee) {
    const cupW = side * 0.28;
    const cupH = side * 0.2;
    const cupX = cx - cupW / 2;
    const cupY = h * 0.48;
    art.push(
      `<path d="M ${cupX} ${cupY} L ${cupX + cupW} ${cupY} L ${cupX + cupW * 0.86} ${cupY + cupH} Q ${cupX + cupW * 0.5} ${cupY + cupH * 1.15} ${cupX + cupW * 0.14} ${cupY + cupH} Z" fill="${palette.accent}"/>`
    );
    art.push(
      `<path d="M ${cupX + cupW} ${cupY + cupH * 0.18} Q ${cupX + cupW * 1.28} ${cupY + cupH * 0.32} ${cupX + cupW} ${cupY + cupH * 0.65}" fill="none" stroke="${palette.accent}" stroke-width="${side * 0.025}"/>`
    );
    art.push(
      `<ellipse cx="${cx}" cy="${cupY + cupH * 1.17}" rx="${cupW * 0.62}" ry="${side * 0.02}" fill="${palette.bg1}" opacity=".6"/>`
    );
    for (let i = 0; i < 3; i += 1) {
      const sx = cupX + cupW * (0.3 + i * 0.2);
      art.push(
        `<path d="M ${sx} ${cupY - side * 0.05} C ${sx - side * 0.06} ${cupY - side * 0.12} ${sx + side * 0.06} ${cupY - side * 0.17} ${sx} ${cupY - side * 0.24}" fill="none" stroke="${palette.text}" stroke-width="${side * 0.008}" opacity=".45"/>`
      );
    }
  }

  // Cat silhouette (works especially well with space).
  if (theme.cat) {
    const catScale = side * 0.2;
    const catX = cx + side * 0.08;
    const catY = h * 0.42;
    art.push(
      `<ellipse cx="${catX}" cy="${catY + catScale * 0.7}" rx="${catScale * 0.52}" ry="${catScale * 0.62}" fill="${palette.text}" opacity=".92"/>`
    );
    art.push(
      `<circle cx="${catX}" cy="${catY}" r="${catScale * 0.42}" fill="${palette.text}" opacity=".96"/>`
    );
    art.push(
      `<path d="M ${catX - catScale * 0.38} ${catY - catScale * 0.22} L ${catX - catScale * 0.3} ${catY - catScale * 0.62} L ${catX - catScale * 0.08} ${catY - catScale * 0.38} Z" fill="${palette.text}" opacity=".96"/>`
    );
    art.push(
      `<path d="M ${catX + catScale * 0.38} ${catY - catScale * 0.22} L ${catX + catScale * 0.3} ${catY - catScale * 0.62} L ${catX + catScale * 0.08} ${catY - catScale * 0.38} Z" fill="${palette.text}" opacity=".96"/>`
    );
    art.push(
      `<path d="M ${catX + catScale * 0.48} ${catY + catScale * 0.48} Q ${catX + catScale * 0.95} ${catY + catScale * 0.5} ${catX + catScale * 0.75} ${catY + catScale * 0.12}" fill="none" stroke="${palette.text}" stroke-width="${catScale * 0.14}" stroke-linecap="round" opacity=".9"/>`
    );
    art.push(
      `<circle cx="${catX - catScale * 0.15}" cy="${catY - catScale * 0.02}" r="${catScale * 0.045}" fill="${palette.accent2}"/>`
    );
    art.push(
      `<circle cx="${catX + catScale * 0.15}" cy="${catY - catScale * 0.02}" r="${catScale * 0.045}" fill="${palette.accent2}"/>`
    );
    if (theme.space) {
      art.push(
        `<circle cx="${catX}" cy="${catY}" r="${catScale * 0.68}" fill="none" stroke="${palette.soft}" stroke-width="${side * 0.008}" opacity=".65"/>`
      );
      art.push(
        `<circle cx="${catX + catScale * 0.52}" cy="${catY - catScale * 0.46}" r="${catScale * 0.06}" fill="${palette.accent}"/>`
      );
    }
  }

  // Flower / food / abstract accents.
  if (theme.flower) {
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      art.push(
        `<ellipse cx="${cx + Math.cos(angle) * side * 0.11}" cy="${h * 0.43 + Math.sin(angle) * side * 0.11}" rx="${side * 0.075}" ry="${side * 0.032}" fill="${i % 2 ? palette.accent : palette.accent2}" opacity=".82" transform="rotate(${(angle * 180) / Math.PI} ${cx + Math.cos(angle) * side * 0.11} ${h * 0.43 + Math.sin(angle) * side * 0.11})"/>`
      );
    }
    art.push(`<circle cx="${cx}" cy="${h * 0.43}" r="${side * 0.05}" fill="${palette.text}" opacity=".9"/>`);
  } else if (theme.food) {
    art.push(`<circle cx="${cx}" cy="${h * 0.47}" r="${side * 0.2}" fill="${palette.accent}" opacity=".82"/>`);
    art.push(`<circle cx="${cx}" cy="${h * 0.47}" r="${side * 0.14}" fill="${palette.accent2}" opacity=".66"/>`);
    art.push(`<circle cx="${cx}" cy="${h * 0.47}" r="${side * 0.07}" fill="${palette.text}" opacity=".8"/>`);
  } else if (!theme.space && !theme.cat && !theme.mountain && !theme.ocean && !theme.coffee && !theme.city) {
    for (let i = 0; i < 5; i += 1) {
      const rx = side * (0.12 + random() * 0.2);
      const ry = side * (0.03 + random() * 0.1);
      art.push(
        `<ellipse cx="${(w * (0.2 + random() * 0.6)).toFixed(1)}" cy="${(h * (0.25 + random() * 0.35)).toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${i % 2 ? palette.accent : palette.accent2}" stroke-width="${Math.max(1, side * 0.004)}" opacity="${(0.25 + random() * 0.4).toFixed(2)}" transform="rotate(${(random() * 90 - 45).toFixed(1)} ${(w * 0.5).toFixed(1)} ${(h * 0.4).toFixed(1)})"/>`
      );
    }
  }

  // Small caption and big prompt line.
  const titleLines = wrapSvgText(prompt, w > h * 1.5 ? 34 : w < h ? 22 : 28, 3);
  const titleSize = Math.round(side * (titleLines.length > 2 ? 0.052 : 0.062));
  const lineHeight = titleSize * 1.08;
  const blockBottom = h - Math.round(side * 0.12);
  const blockTop = blockBottom - (titleLines.length - 1) * lineHeight;
  const title = titleLines
    .map(
      (line, index) =>
        `<text x="${Math.round(side * 0.08)}" y="${Math.round(blockTop + index * lineHeight)}" fill="${palette.text}" font-family="Inter, Arial, sans-serif" font-size="${titleSize}" font-weight="650" letter-spacing="${(-titleSize * 0.02).toFixed(2)}">${escapeXml(line)}</text>`
    )
    .join('');
  const label = escapeXml(`${(style || 'Lumio Vision').split(',')[0].slice(0, 40)} · ${seed}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.bg1}"/><stop offset="1" stop-color="${palette.bg2}"/></linearGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.bg1}" stop-opacity="0"/><stop offset="1" stop-color="${palette.bg1}" stop-opacity=".92"/></linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="${side * 0.045}"/></filter>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".18"/></feComponentTransfer></filter>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <g filter="url(#blur)" opacity=".75"><circle cx="${w * 0.2}" cy="${h * 0.25}" r="${side * 0.3}" fill="${palette.accent}" opacity=".2"/><circle cx="${w * 0.84}" cy="${h * 0.2}" r="${side * 0.24}" fill="${palette.accent2}" opacity=".18"/></g>
    ${art.join('\n')}
    <rect y="${h * 0.58}" width="${w}" height="${h * 0.42}" fill="url(#fade)"/>
    <text x="${Math.round(side * 0.08)}" y="${Math.round(h * 0.1)}" fill="${palette.text}" opacity=".72" font-family="Inter, Arial, sans-serif" font-size="${Math.round(side * 0.022)}" letter-spacing="${side * 0.005}">AURALIS VISION · LOCAL EDITION</text>
    <text x="${Math.round(side * 0.08)}" y="${Math.round(h * 0.145)}" fill="${palette.text}" opacity=".4" font-family="Inter, Arial, sans-serif" font-size="${Math.round(side * 0.014)}" letter-spacing="${side * 0.003}">${escapeXml(label.toUpperCase())}</text>
    ${title}
    <rect x="${Math.round(side * 0.08)}" y="${Math.round(h - side * 0.085)}" width="${Math.round(side * 0.18)}" height="${Math.max(2, Math.round(side * 0.003))}" fill="${palette.accent}"/>
    <rect width="${w}" height="${h}" filter="url(#grain)" opacity=".16" style="mix-blend-mode:overlay"/>
    <rect x="${side * 0.035}" y="${side * 0.035}" width="${w - side * 0.07}" height="${h - side * 0.07}" fill="none" stroke="${palette.text}" stroke-width="${Math.max(1, side * 0.0015)}" opacity=".18"/>
  </svg>`;

  return {
    buffer: Buffer.from(svg, 'utf8'),
    contentType: 'image/svg+xml',
    source: 'Lumio Vision',
    width: w,
    height: h,
    retryAfter: 0,
  };
}

function saveGeneratedImage({
  buffer,
  contentType,
  prompt,
  style,
  width,
  height,
  source,
  fallback = false,
  externalUrl = '',
}) {
  const mime = contentType || 'image/jpeg';
  // На Vercel файловая система только для чтения. Возвращаем прямую ссылку
  // генератора (она стабильна благодаря seed) или data URL.
  if (IS_VERCEL && externalUrl) {
    return {
      url: externalUrl,
      width,
      height,
      prompt,
      style,
      source,
      fallback,
      storage: 'external',
      cooldown: 0,
    };
  }

  try {
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : mime.includes('svg')
          ? 'svg'
          : 'jpg';
    const filename = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(GENERATED_DIR, filename), buffer);
    return {
      url: `/generated/${filename}`,
      width,
      height,
      prompt,
      style,
      source,
      fallback,
      storage: 'file',
      cooldown: 0,
    };
  } catch {
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return {
      url: dataUrl,
      width,
      height,
      prompt,
      style,
      source,
      fallback,
      storage: 'data',
      cooldown: 0,
    };
  }
}

async function handleImageGenerate(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 700) : '';
  if (!prompt) return sendJson(res, 400, { error: 'Опишите, что нарисовать' });

  const width = clampImageSize(body.width, 1024);
  const height = clampImageSize(body.height, 1024);
  const style = typeof body.style === 'string' ? body.style.trim().slice(0, 180) : '';
  const seedRaw = Number.parseInt(body.seed, 10);
  const seed = Number.isFinite(seedRaw)
    ? Math.abs(seedRaw) % 2147483647
    : Math.floor(Math.random() * 1000000);

  const waiting = imageCooldownRemaining();
  if (waiting > 0) {
    return sendJson(
      res,
      429,
      {
        error: `Генераторы изображений отдыхают. Следующая попытка через ${waiting} с.`,
        retryAfter: waiting,
        code: 'COOLDOWN',
      },
      { 'Retry-After': String(waiting) }
    );
  }

  if (imageInFlight) {
    return sendJson(
      res,
      429,
      {
        error: 'Изображение уже создаётся. Подождите пару секунд.',
        retryAfter: 2,
        code: 'IN_FLIGHT',
      },
      { 'Retry-After': '2' }
    );
  }

  imageInFlight = true;
  const startedAt = Date.now();
  try {
    const translated = await translatePrompt(prompt);
    const failures = [];

    // Сначала новые модели изображений (первой идёт бесплатная recraft).
    for (const model of IMAGE_MODELS) {
      const result = await fetchGatewayImage({ prompt: translated, width, height, model });
      if (result.buffer) {
        imageAllowedAt = 0;
        const saved = saveGeneratedImage({ ...result, prompt, style, width, height });
        return sendJson(res, 200, saved, { 'X-Lumio-Image-Source': result.source });
      }
      failures.push(result.retryAfter || IMAGE_FALLBACK_WAIT);
      if (Date.now() - startedAt > (IS_VERCEL ? 30000 : 90000)) break;
    }

    // Pollinations — самый быстрый и стабильный бесплатный канал.
    const pollinations = await fetchPollinationsImage({
      prompt: translated,
      style,
      width,
      height,
      seed,
    });
    if (pollinations.buffer) {
      imageAllowedAt = 0;
      const saved = saveGeneratedImage({
        ...pollinations,
        prompt,
        style,
        width,
        height,
        externalUrl: pollinations.externalUrl,
      });
      return sendJson(res, 200, saved, { 'X-Lumio-Image-Source': 'Pollinations' });
    }
    failures.push(pollinations.retryAfter || IMAGE_FALLBACK_WAIT);

    // Stable Horde может быть медленным и не помещается в лимит Vercel.
    if (!IS_VERCEL) {
      const horde = await fetchStableHordeImage({
        prompt: translated,
        style,
        width,
        height,
        seed,
      });
      if (horde.buffer) {
        imageAllowedAt = 0;
        return sendJson(
          res,
          200,
          saveGeneratedImage({
            ...horde,
            prompt,
            style,
            width: horde.width,
            height: horde.height,
          }),
          { 'X-Lumio-Image-Source': 'Stable Horde' }
        );
      }
      failures.push(horde.retryAfter || IMAGE_FALLBACK_WAIT);
    }

    // Внешние генераторы могут быть заняты или требовать ключ. Вместо красной
    // ошибки собираем локальную иллюстрацию по тому же промпту.
    const local = buildLocalImage({ prompt, style, width, height, seed });
    imageAllowedAt = 0;
    console.warn('[image] local fallback', failures.join(', '));
    return sendJson(
      res,
      200,
      {
        ...saveGeneratedImage({ ...local, prompt, style }),
        fallback: true,
        note: 'Внешние генераторы сейчас заняты. Показана локальная иллюстрация по вашему описанию.',
        retryAfter: Math.max(5, Math.min(...failures)),
      },
      { 'X-Lumio-Image-Source': 'local' }
    );
  } catch (error) {
    console.error('[image generate]', error?.message || error);
    imageAllowedAt = 0;
    return sendJson(res, 502, {
      error: 'Не удалось подключиться к генератору изображений. Проверьте интернет.',
    });
  } finally {
    imageInFlight = false;
  }
}

async function handleImage(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const prompt = (url.searchParams.get('prompt') || '').trim().slice(0, 700);
  if (!prompt) return sendJson(res, 400, { error: 'Опишите, что нарисовать' });

  const width = clampImageSize(url.searchParams.get('width'), 1024);
  const height = clampImageSize(url.searchParams.get('height'), 1024);
  const seedRaw = Number.parseInt(url.searchParams.get('seed'), 10);
  const seed = Number.isFinite(seedRaw)
    ? Math.abs(seedRaw) % 2147483647
    : Math.floor(Math.random() * 1000000);
  const style = (url.searchParams.get('style') || '').trim().slice(0, 160);
  const target = buildImageTarget({ prompt, style, width, height, seed });

  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*',
        'User-Agent': 'Lumio/1.0 (local AI workspace)',
      },
      signal: AbortSignal.timeout(120000),
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !upstream.body || !contentType.startsWith('image/')) {
      const failure = await parseImageFailure(upstream);
      const retryAfter = failure.retryAfter || (upstream.status === 402 ? 45 : 10);
      if (upstream.status === 402 || upstream.status === 429) {
        return sendJson(
          res,
          429,
          {
            error: `Бесплатный лимит изображений исчерпан. Следующая картинка через ${retryAfter} с.`,
            retryAfter,
            code: 'FREE_LIMIT',
          },
          { 'Retry-After': String(retryAfter) }
        );
      }
      return sendJson(res, 502, {
        error: `Генератор изображений ответил ошибкой ${upstream.status}. Попробуйте ещё раз.`,
        retryAfter,
      });
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'X-Image-Source': 'Pollinations',
    });
    for await (const chunk of upstream.body) {
      if (res.writableEnded) return;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const message =
      error?.name === 'TimeoutError'
        ? 'Генератор изображений не ответил за 2 минуты. Попробуйте ещё раз.'
        : 'Не удалось сгенерировать изображение. Проверьте подключение к интернету.';
    console.error('[image error]', error?.message || error);
    sendJson(res, 504, { error: message });
  }
}

async function handleImageDownload(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const raw = (url.searchParams.get('url') || '').trim();
  let target;
  try {
    target = new URL(raw);
  } catch {
    return sendJson(res, 400, { error: 'Некорректная ссылка' });
  }
  const host = target.hostname.toLowerCase();
  const allowed =
    host.endsWith('pollinations.ai') ||
    host.endsWith('stablehorde.net') ||
    host.endsWith('horde.ninja');
  if (target.protocol !== 'https:' || !allowed) {
    return sendJson(res, 403, { error: 'Ссылка не разрешена' });
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Lumio/1.0 (image download)' },
      signal: AbortSignal.timeout(45000),
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      return sendJson(res, 502, { error: 'Не удалось скачать изображение' });
    }
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="auralis-${Date.now()}.${ext}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    for await (const chunk of upstream.body) {
      if (res.writableEnded) return;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Не удалось скачать изображение' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function demoReply(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = last ? last.content.toLowerCase() : '';
  const topic = last ? last.content.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  const connect =
    '> **Локальный ответ.** Бесплатные модели сейчас перегружены, поэтому отвечает встроенная подсказка. Это не ошибка ключа и не сбой приложения.\n\n' +
    'Через минуту отправьте сообщение ещё раз — Lumio автоматически попробует все бесплатные каналы. Для стабильных ответов можно подключить Claude, Gemini, GPT или OpenRouter в **Настройках**.\n\n';

  if (/(нарисуй|сделай фото|создай фото|сгенерируй (фото|картинку|изображение)|фотк|картинк|изображени)/i.test(text)) {
    return (
      '## Картинка по вашему описанию\n\n' +
      (topic ? `Промпт: **${topic}**\n\n` : '') +
      'Откройте раздел **Картинки** — там генератор работает без ключа и создаст изображение именно по этому описанию. ' +
      'Можно выбрать стиль (кино, фото, 3D, аниме, неон) и формат.\n\n' +
      'Если бесплатные модели перегружены, генератор картинок всё равно попробует Pollinations и Stable Horde, а при их недоступности соберёт локальную иллюстрацию по промпту.'
    );
  }

  if (/(сделай сайт|создай сайт|собери сайт|сверстай|лендинг|сайт для)/i.test(text)) {
    return (
      '## Сайт по вашему описанию\n\n' +
      (topic ? `Промпт: **${topic}**\n\n` : '') +
      'Откройте **Студию сайтов** — она собирает готовый HTML строго по описанию, с превью, кодом и скачиванием. ' +
      'Бесплатная модель используется автоматически, ключ не нужен.\n\n' +
      'Если модель не ответит, студия покажет резервный шаблон и предложит повторить — без пустого экрана.'
    );
  }

  if (/^(привет|здравств|хай|ку|hello|hi)/i.test(text)) {
    return (
      '## Привет! Я Lumio 👋\n\n' +
      'Я — AI-пространство для диалогов, сайтов и изображений. Сейчас бесплатные модели заняты, поэтому отвечаю локальной подсказкой.\n\n' +
      '**Что можно сделать:**\n\n' +
      '1. Подождать минуту и повторить сообщение.\n' +
      '2. Открыть **Настройки** и подключить Claude, Gemini, GPT или OpenRouter.\n' +
      '3. Пока посмотреть интерфейс: историю, студию сайтов, картинки и библиотеку.\n\n' +
      'Как только бесплатный канал освободится, я отвечу по-настоящему — без ключа.'
    );
  }

  if (/(что ты умеешь|кто ты|возможност|что можешь|help)/i.test(text)) {
    return (
      '## Что умеет Lumio\n\n' +
      '- **Объяснять сложное** — от квантовой физики до налогов;\n' +
      '- **Писать и проверять код** — Python, JavaScript, SQL и другие языки;\n' +
      '- **Помогать с текстами** — письма, статьи, резюме, посты;\n' +
      '- **Строить планы** — проекты, обучение, путешествия, запуск бизнеса;\n' +
      '- **Собирать сайты** и генерировать изображения.\n\n' +
      'Сейчас бесплатные модели перегружены. Повторите запрос через минуту или подключите своего провайдера в настройках — тогда ответы будут стабильными и без пауз.'
    );
  }

  if (/(код|python|javascript|сайт|программ|скрипт|html|react|api)/i.test(text)) {
    return (
      '## Пример кода\n\n' +
      'Пока бесплатная модель занята, вот рабочий пример — сортировка файлов по расширениям:\n\n' +
      '```python\n' +
      'from pathlib import Path\n' +
      'import shutil\n\n' +
      'CATEGORIES = {\n' +
      '    "images": {".jpg", ".jpeg", ".png", ".gif", ".webp"},\n' +
      '    "docs":   {".pdf", ".docx", ".txt", ".md"},\n' +
      '    "audio":  {".mp3", ".wav", ".flac"},\n' +
      '    "video":  {".mp4", ".mov", ".mkv"},\n' +
      '}\n\n' +
      'def sort_files(folder: str) -> None:\n' +
      '    for file in Path(folder).iterdir():\n' +
      '        if not file.is_file():\n' +
      '            continue\n' +
      '        target = next(\n' +
      '            (name for name, ext in CATEGORIES.items() if file.suffix.lower() in ext),\n' +
      '            "other",\n' +
      '        )\n' +
      '        dest = file.parent / target\n' +
      '        dest.mkdir(exist_ok=True)\n' +
      '        shutil.move(str(file), dest / file.name)\n\n' +
      'if __name__ == "__main__":\n' +
      '    sort_files("Downloads")\n' +
      '```\n\n' +
      'Повторите вопрос через минуту — и я напишу код под вашу задачу, объясню его и найду ошибки.'
    );
  }

  if (/(иде[яй]|контент|придума|креатив|назв)/i.test(text)) {
    return (
      '## 5 идей, чтобы размяться\n\n' +
      '1. **«Один день из жизни»** — короткие истории о людях необычных профессий.\n' +
      '2. **Разбор мифов** — популярное заблуждение и что на самом деле.\n' +
      '3. **До / после** — наглядные трансформации: ремонт, код, текст, тренировка.\n' +
      '4. **Мини-интервью** — три вопроса эксперту, которые все стесняются задать.\n' +
      '5. **Челлендж на 7 дней** — публичный эксперимент с результатами.\n\n' +
      'Бесплатная модель сейчас занята. Повторите запрос через минуту — и я придумаю идеи под вашу нишу, аудиторию и площадку.'
    );
  }

  if (/(объясни|как работает|что такое|почему|простыми словами)/i.test(text)) {
    return (
      '## Коротко\n\n' +
      'Хорошее объяснение строится в три шага: **простая аналогия → ключевой механизм → пример из жизни**.\n\n' +
      'Например, нейросеть можно представить как очень начитанного собеседника: он не «знает» ответ, а предсказывает наиболее подходящее продолжение, опираясь на миллиарды примеров текста.\n\n' +
      'Сейчас бесплатная модель перегружена, поэтому это локальная подсказка. Повторите вопрос через минуту — я разберу именно его: по шагам, с примерами и без лишней сложности.'
    );
  }

  return (
    connect +
    (topic ? `Ваш запрос: «${topic}».\n\n` : '') +
    'Повторите сообщение через минуту — Lumio сам попробует бесплатные модели ещё раз. Если паузы повторяются, подключите своего провайдера в настройках: ответы будут приходить быстрее и стабильнее.'
  );
}

function streamDemo(res, text) {
  const parts = text.match(/\S+\s*/g) || [text];
  const chunks = [];
  for (let i = 0; i < parts.length; i += 3) {
    chunks.push(parts.slice(i, i + 3).join(''));
  }

  let index = 0;
  const push = () => {
    if (res.writableEnded) return;
    if (index >= chunks.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`
    );
    index += 1;
    setTimeout(push, 16 + Math.random() * 20);
  };

  res.on('close', () => {
    index = chunks.length;
  });
  setTimeout(push, 180);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный URL' });
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const root = path.resolve(PUBLIC_DIR) + path.sep;
  if (!filePath.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Страница не найдена');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self' blob: data: about:; media-src 'self' blob: data: https:; object-src 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(data);
  });
}

function cleanupGeneratedImages(limit = 120) {
  try {
    const files = fs
      .readdirSync(GENERATED_DIR)
      .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
      .map((name) => ({
        name,
        time: fs.statSync(path.join(GENERATED_DIR, name)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);
    for (const file of files.slice(limit)) {
      try {
        fs.unlinkSync(path.join(GENERATED_DIR, file.name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

cleanupGeneratedImages();

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный URL' });
  }

  if (req.method === 'GET' && (url.pathname === '/api/status' || url.pathname === '/api/health')) {
    const providers = {
      free: true,
      openrouter: Boolean(PROVIDERS.openrouter.envKey),
      anthropic: Boolean(PROVIDERS.anthropic.envKey),
      gemini: Boolean(PROVIDERS.gemini.envKey),
      openai: Boolean(PROVIDERS.openai.envKey),
      custom: Boolean(PROVIDERS.custom.envKey),
    };
    return sendJson(res, 200, {
      ok: true,
      hasKey: ['openrouter', 'anthropic', 'gemini', 'openai', 'custom'].some(
        (name) => providers[name]
      ),
      providers,
      free: true,
      freeModels: FREE_MODELS,
      site: true,
      images: true,
      imageCooldown: imageCooldownRemaining(),
      runtime: IS_VERCEL ? 'vercel' : 'node',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return handleChat(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/site') {
    return handleSiteGenerate(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/models') {
    return handleModels(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/image/generate') {
    return handleImageGenerate(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/image/download') {
    return handleImageDownload(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/image') {
    return handleImage(req, res);
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
    return serveStatic(req, res);
  }

  return sendJson(res, 405, { error: 'Метод не разрешён' });
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((error) => {
    console.error('[request]', error?.message || error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

if (require.main === module) {
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n  Порт ${PORT} занят. Запустите: PORT=4174 npm start\n`);
    } else {
      console.error('\n  Ошибка сервера:', error.message, '\n');
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const configured = [
      PROVIDERS.openrouter.envKey ? 'OpenRouter' : '',
      PROVIDERS.anthropic.envKey ? 'Anthropic' : '',
      PROVIDERS.gemini.envKey ? 'Gemini' : '',
      PROVIDERS.openai.envKey ? 'OpenAI' : '',
      PROVIDERS.custom.envKey ? 'Custom' : '',
    ].filter(Boolean);
    console.log('');
    console.log('  ✦  Lumio запущен');
    console.log(`  →  http://${HOST}:${PORT}`);
    console.log(
      `  ⚙  Чат: Lumio Free без ключа${
        configured.length ? ` · env-ключи: ${configured.join(', ')}` : ''
      }`
    );
    console.log('');
  });

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

module.exports = {
  handleRequest,
  buildLocalImage,
  hordeImageSize,
  fetchStableHordeImage,
  buildFreeChain,
  FREE_MODELS,
  IMAGE_MODELS,
};
