export const config = { runtime: 'edge' };

const ALLOWED_VIEWS = [
  'v_chat_list_json',
  'v_message_json',
  'v_users_summary',
];

/* ═══════════════════════════════════════════════════════════════
   WRITE ALLOWLIST — per-table, per-op column lists
   ═══════════════════════════════════════════════════════════════ */
const WRITE_ALLOWED = {
  users: {
    insert: ['name','avatar_color','avatar_initial','is_verified','is_online','is_bot'],
  },
  chats: {
    insert: ['kind','peer_user_id','title','avatar_color','avatar_initial','is_verified','created_at'],
  },
  chat_members: {
    insert: ['chat_id','user_id','role','joined_at'],
  },
  chat_state: {
    insert: ['user_id','chat_id','is_muted','is_pinned','is_archived','unread_count','position','last_activity_text','preview_sender','preview_media'],
    update: ['is_muted','is_pinned','is_archived','unread_count','position','last_activity_text','preview_sender','preview_media'],
  },
  chat_preview_parts: {
    insert: ['user_id','chat_id','idx','text','redacted'],
    delete: true,
  },
  messages: {
    insert: ['chat_id','sender_user_id','ts','text_content','protected_text','service_action','forward_from_user_id','forward_from_chat_id','forward_from_name','forward_from_color','forward_from_initial','reply_to_message_id','views','signature','outgoing_status'],
  },
  media: {
    insert: ['message_id','kind','aspect_ratio','duration','file_name','file_size','mime_type'],
  },
  media_items: {
    insert: ['message_id','idx','aspect_ratio','duration'],
  },
  message_entities: {
    insert: ['message_id','target','idx','kind','content','href','bold','italic','redacted'],
  },
};

const WRITE_PK = {
  chat_state: ['user_id','chat_id'],
  chat_preview_parts: ['user_id','chat_id'],
};

const AUTOINC_TABLES = ['users','chats','messages'];

/* ═══════════════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════════════ */
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  const pathname = new URL(req.url).pathname;

  if (req.method === 'GET') {
    return jsonResponse({
      ok: true, ready: true, views: ALLOWED_VIEWS,
      config: {
        host:       !!process.env.TURSO_HOST,
        token:      !!process.env.TURSO_TOKEN,
        writeToken: !!process.env.TURSO_WRITE_TOKEN,
      },
    });
  }

  if (req.method === 'POST' && pathname === '/api/edit-message') return handleEditMessage(req);
  if (req.method === 'POST' && pathname === '/api/write')        return handleWrite(req);
  if (req.method === 'POST')                                     return handleSelect(req);

  return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
}

/* ═══════════════════════════════════════════════════════════════
   POST /api — whitelisted SELECT
   ═══════════════════════════════════════════════════════════════ */
async function handleSelect(req) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400); }

  const { sql, args = [] } = body || {};
  if (!sql || typeof sql !== 'string') return jsonResponse({ ok: false, error: '"sql" is required' }, 400);
  if (!Array.isArray(args)) return jsonResponse({ ok: false, error: '"args" must be an array' }, 400);

  const validationError = validateQuery(sql);
  if (validationError) return jsonResponse({ ok: false, error: validationError }, 403);

  const host  = process.env.TURSO_HOST;
  const token = process.env.TURSO_TOKEN;
  if (!host || !token) return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);

  try {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql, args: args.map(encodeArg) } },
          { type: 'close' },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) return jsonResponse({ ok: false, error: `Turso ${res.status}: ${text.slice(0, 300)}` }, 502);
    const data = JSON.parse(text);
    const first = data.results?.[0];
    if (!first) return jsonResponse({ ok: false, error: 'Empty response' }, 502);
    if (first.type === 'error') return jsonResponse({ ok: false, error: first.error?.message || 'Query error' }, 400);
    const result = first.response?.result;
    if (!result) return jsonResponse({ ok: false, error: 'No result' }, 502);
    const cols = result.cols?.map(c => c.name) || [];
    const rows = result.rows?.map(row => {
      const obj = {};
      row.forEach((cell, i) => { obj[cols[i]] = cell?.value ?? null; });
      return obj;
    }) || [];
    return jsonResponse({ ok: true, rowCount: rows.length, cols, rows });
  } catch (err) {
    return jsonResponse({ ok: false, error: `Fetch failed: ${err.message}` }, 502);
  }
}

/* ═══════════════════════════════════════════════════════════════
   POST /api/write — batched inserts/updates/deletes
   Body: { ops: [{ kind, table, values|set|where }] }
   ═══════════════════════════════════════════════════════════════ */
async function handleWrite(req) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400); }

  const { ops } = body || {};
  if (!Array.isArray(ops) || ops.length === 0) return jsonResponse({ ok: false, error: 'ops must be non-empty array' }, 400);
  if (ops.length > 50) return jsonResponse({ ok: false, error: 'Too many ops (max 50)' }, 400);

  const host  = process.env.TURSO_HOST;
  const token = process.env.TURSO_WRITE_TOKEN;
  if (!host || !token) return jsonResponse({ ok: false, error: 'Server misconfigured: TURSO_WRITE_TOKEN missing' }, 500);

  const prepared = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object') return jsonResponse({ ok: false, error: `op[${i}] invalid` }, 400);
    const { kind, table } = op;
    if (!['insert','update','delete'].includes(kind)) return jsonResponse({ ok: false, error: `op[${i}]: kind must be insert|update|delete` }, 400);
    if (!table || !WRITE_ALLOWED[table]) return jsonResponse({ ok: false, error: `op[${i}]: forbidden table '${table}'` }, 400);

    if (kind === 'insert') {
      const allowed = WRITE_ALLOWED[table].insert || [];
      const values = op.values || {};
      const cols = Object.keys(values);
      if (cols.length === 0) return jsonResponse({ ok: false, error: `op[${i}]: no values` }, 400);
      for (const c of cols) if (!allowed.includes(c)) return jsonResponse({ ok: false, error: `op[${i}]: forbidden column '${c}'` }, 400);
      const autoinc = AUTOINC_TABLES.includes(table);
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})` + (autoinc ? ' RETURNING id' : '');
      prepared.push({ kind, table, sql, args: cols.map(c => encodeArg(values[c])), autoinc });
    } else if (kind === 'update') {
      const allowed = WRITE_ALLOWED[table].update || [];
      const pk = WRITE_PK[table] || [];
      const set = op.set || {};
      const where = op.where || {};
      const setCols = Object.keys(set);
      const whereCols = Object.keys(where);
      if (setCols.length === 0) return jsonResponse({ ok: false, error: `op[${i}]: no set values` }, 400);
      if (whereCols.length === 0) return jsonResponse({ ok: false, error: `op[${i}]: no where values` }, 400);
      for (const c of setCols) if (!allowed.includes(c)) return jsonResponse({ ok: false, error: `op[${i}]: forbidden set column '${c}'` }, 400);
      for (const c of whereCols) if (!pk.includes(c)) return jsonResponse({ ok: false, error: `op[${i}]: where must be PK columns (${pk.join(', ')})` }, 400);
      const sql = `UPDATE ${table} SET ${setCols.map(c=>`${c}=?`).join(',')} WHERE ${whereCols.map(c=>`${c}=?`).join(' AND ')}`;
      const args = [
        ...setCols.map(c => encodeArg(set[c])),
        ...whereCols.map(c => encodeArg(where[c])),
      ];
      prepared.push({ kind, table, sql, args, autoinc: false });
    } else {
      if (!WRITE_ALLOWED[table].delete) return jsonResponse({ ok: false, error: `op[${i}]: delete not allowed on '${table}'` }, 400);
      const pk = WRITE_PK[table] || [];
      const where = op.where || {};
      const whereCols = Object.keys(where);
      if (whereCols.length === 0) return jsonResponse({ ok: false, error: `op[${i}]: no where values` }, 400);
      for (const c of whereCols) if (!pk.includes(c)) return jsonResponse({ ok: false, error: `op[${i}]: where must be PK columns` }, 400);
      const sql = `DELETE FROM ${table} WHERE ${whereCols.map(c=>`${c}=?`).join(' AND ')}`;
      prepared.push({ kind, table, sql, args: whereCols.map(c => encodeArg(where[c])), autoinc: false });
    }
  }

  const requests = [{ type: 'execute', stmt: { sql: 'BEGIN', args: [] } }];
  for (const p of prepared) requests.push({ type: 'execute', stmt: { sql: p.sql, args: p.args } });
  requests.push({ type: 'execute', stmt: { sql: 'COMMIT', args: [] } });
  requests.push({ type: 'close' });

  let data;
  try {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    const text = await res.text();
    if (!res.ok) return jsonResponse({ ok: false, error: `Turso ${res.status}: ${text.slice(0, 300)}` }, 502);
    data = JSON.parse(text);
  } catch (err) {
    return jsonResponse({ ok: false, error: `Fetch failed: ${err.message}` }, 502);
  }

  for (let i = 1; i <= prepared.length; i++) {
    const r = data.results?.[i];
    if (r?.type === 'error') {
      return jsonResponse({ ok: false, error: `op[${i-1}] (${prepared[i-1].kind} ${prepared[i-1].table}): ${r.error?.message || 'failed'}` }, 400);
    }
  }

  const results = prepared.map((p, i) => {
    const r = data.results?.[i + 1]?.response?.result;
    const id = p.autoinc && r?.rows?.[0]?.[0]?.value != null ? Number(r.rows[0][0].value) : null;
    return { op: i, kind: p.kind, table: p.table, id };
  });

  return jsonResponse({ ok: true, results });
}

/* ═══════════════════════════════════════════════════════════════
   POST /api/edit-message — (unchanged from before)
   ═══════════════════════════════════════════════════════════════ */
async function handleEditMessage(req) {
  let body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400); }

  const { chatId, messageId, entities } = body || {};
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return jsonResponse({ ok: false, error: 'chatId required' }, 400);
  if (typeof messageId !== 'number' && typeof messageId !== 'string') return jsonResponse({ ok: false, error: 'messageId required' }, 400);
  if (!Array.isArray(entities) || entities.length === 0) return jsonResponse({ ok: false, error: 'entities must be non-empty array' }, 400);
  for (const e of entities) {
    if (!e || typeof e.type !== 'string') return jsonResponse({ ok: false, error: 'every entity needs a type' }, 400);
    if (e.type !== 'br' && typeof e.text !== 'string') return jsonResponse({ ok: false, error: 'every non-br entity needs text' }, 400);
    if (e.type === 'url' && typeof e.href !== 'string') return jsonResponse({ ok: false, error: 'url entities need href' }, 400);
  }

  const host  = process.env.TURSO_HOST;
  const token = process.env.TURSO_TOKEN;
  if (!host || !token) return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500);

  /* Look up content_type */
  let lookupData;
  try {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [
        { type: 'execute', stmt: {
          sql: 'SELECT protected_text IS NOT NULL AS is_protected, (SELECT COUNT(*) FROM media WHERE message_id = messages.id) AS media_count FROM messages WHERE chat_id = ? AND id = ?',
          args: [encodeArg(chatId), encodeArg(messageId)],
        } },
        { type: 'close' },
      ] }),
    });
    lookupData = await res.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: `Lookup failed: ${err.message}` }, 502);
  }

  const lr = lookupData.results?.[0]?.response?.result;
  if (!lr?.rows?.length) return jsonResponse({ ok: false, error: 'Message not found' }, 404);

  const isProtected = lr.rows[0][0]?.value == 1;
  const mediaCount  = Number(lr.rows[0][1]?.value || 0);

  const requests = [{ type: 'execute', stmt: { sql: 'BEGIN', args: [] } }];

  if (isProtected) {
    const flat = entities.map(e => e.text || '').join('');
    requests.push({ type: 'execute', stmt: {
      sql: 'UPDATE messages SET protected_text = ? WHERE chat_id = ? AND id = ?',
      args: [encodeArg(flat), encodeArg(chatId), encodeArg(messageId)],
    } });
  } else {
    const target = mediaCount > 0 ? 'caption' : 'text';
    requests.push({ type: 'execute', stmt: {
      sql: 'DELETE FROM message_entities WHERE message_id = ? AND target = ?',
      args: [encodeArg(messageId), encodeArg(target)],
    } });
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      requests.push({ type: 'execute', stmt: {
        sql: 'INSERT INTO message_entities (message_id, target, idx, kind, content, href, bold, italic, redacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [
          encodeArg(messageId), encodeArg(target), encodeArg(i),
          encodeArg(e.type),
          encodeArg(e.text ?? null),
          encodeArg(e.href ?? null),
          encodeArg(e.bold ? 1 : 0),
          encodeArg(e.italic ? 1 : 0),
          encodeArg(e.redacted ? 1 : 0),
        ],
      } });
    }
  }

  requests.push({ type: 'execute', stmt: { sql: 'COMMIT', args: [] } });
  requests.push({ type: 'close' });

  try {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    const text = await res.text();
    const data = JSON.parse(text);
    const errorResult = data.results?.find(r => r.type === 'error');
    if (errorResult) return jsonResponse({ ok: false, error: errorResult.error?.message || 'Write failed' }, 400);
    return jsonResponse({ ok: true, chatId, messageId });
  } catch (err) {
    return jsonResponse({ ok: false, error: `Write failed: ${err.message}` }, 502);
  }
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
function validateQuery(sql) {
  const lower = sql.toLowerCase().trim();
  if (!lower.startsWith('select')) return 'Only SELECT queries are allowed';
  if (/;\s*\S/.test(sql)) return 'Multi-statement queries are not allowed';
  const banned = ['insert','update','delete','drop','alter','create','pragma','attach','detach','vacuum','replace','trigger'];
  for (const kw of banned) if (new RegExp(`\\b${kw}\\b`, 'i').test(sql)) return `Forbidden keyword: ${kw}`;
  if (/\bfrom\s+[a-z_][a-z0-9_]*\s*,/i.test(sql)) return 'Comma joins not allowed; use explicit JOIN';
  const tableRegex = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  const tables = [...sql.matchAll(tableRegex)].map(m => m[1].toLowerCase());
  if (tables.length === 0) return 'Query must reference a table or view';
  for (const t of tables) if (!ALLOWED_VIEWS.includes(t)) return `Forbidden table or view: ${t}`;
  return null;
}

function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { type: 'integer', value: String(v) };
    return { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Origin, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...corsHeaders(),
    },
  });
}
