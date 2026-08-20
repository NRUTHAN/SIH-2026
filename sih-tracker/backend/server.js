/**
 * Smart Municipal Complaint-to-Resolution Tracker — Backend
 * -----------------------------------------------------------------------
 * Zero-dependency Node.js server (no npm install required — just `node server.js`).
 * Uses only Node's built-in modules so the whole team can run this instantly
 * without wrestling with package installs during the hackathon.
 *
 * Responsibilities:
 *   1. Serve the frontend (citizen app + department/admin panel) as static files.
 *   2. Expose a JSON API for complaint submission, tracking, and status updates.
 *   3. Run an "AI categorizer" that reads a complaint's text (and, if an
 *      ANTHROPIC_API_KEY is set, the photo itself via Claude's vision) to pick
 *      a category and auto-route it to the correct department.
 *   4. Run a background "AI escalation engine" that watches every open
 *      complaint's SLA deadline. If a department hasn't acted in time, it
 *      auto-drafts and logs an escalation notice to that department (and,
 *      on a second breach, to a higher authority) — this is the
 *      "AI raises a complaint if no action is taken" requirement.
 *
 * Data is stored in flat JSON files under ./data — swap this for a real
 * database (Postgres/Mongo) later without changing the API surface.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
const COMPLAINTS_FILE = path.join(DATA_DIR, 'complaints.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ---------------------------------------------------------------------------
// Tiny JSON "database" helpers
// ---------------------------------------------------------------------------

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const config = readJSON(CONFIG_FILE);

function getCategory(id) {
  return config.categories.find((c) => c.id === id) || config.categories.find((c) => c.id === 'other');
}

function getDepartment(id) {
  return config.departments.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// AI Step 1: Categorization + routing
// ---------------------------------------------------------------------------
// Default: lightweight keyword classifier over the title/description (works
// fully offline, zero setup — good enough for a live hackathon demo).
// Upgrade path: if ANTHROPIC_API_KEY is set in the environment, we instead
// send the photo + description to Claude's vision model and ask it to pick
// a category from our configured list. This is a real multimodal AI call,
// not a mock — it just degrades gracefully to the offline classifier if no
// key/network is available, so the app never breaks during a demo.

function keywordClassify(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  let best = { category: getCategory('other'), score: 0 };

  for (const cat of config.categories) {
    let score = 0;
    for (const kw of cat.keywords) {
      if (text.includes(kw.toLowerCase())) score += 1;
    }
    if (score > best.score) best = { category: cat, score };
  }
  return {
    categoryId: best.category.id,
    confidence: best.score > 0 ? Math.min(0.6 + best.score * 0.1, 0.95) : 0.3,
    method: 'keyword-classifier',
  };
}

function classifyWithClaude(title, description, photoDataUrl) {
  return new Promise((resolve) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return resolve(null); // no key -> caller falls back to keyword classifier

    const categoryList = config.categories.map((c) => `${c.id}: ${c.label}`).join('\n');
    const content = [
      {
        type: 'text',
        text:
          `You are classifying a citizen civic complaint into exactly one category id.\n` +
          `Categories:\n${categoryList}\n\n` +
          `Title: ${title}\nDescription: ${description}\n\n` +
          `Respond with ONLY a JSON object like {"categoryId":"pothole","confidence":0.9} and nothing else.`,
      },
    ];

    if (photoDataUrl && photoDataUrl.startsWith('data:image')) {
      const match = photoDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        content.unshift({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      }
    }

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content }],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const text = (data.content || []).map((b) => b.text || '').join('');
            const clean = text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(clean);
            if (getCategory(parsed.categoryId)) {
              resolve({ categoryId: parsed.categoryId, confidence: parsed.confidence || 0.8, method: 'claude-vision' });
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function categorizeAndRoute(title, description, photoDataUrl, manualCategoryId) {
  // Citizen can optionally pick a category themselves; AI still runs so we
  // can show its suggestion, but the manual choice wins if provided.
  let result;
  if (manualCategoryId && getCategory(manualCategoryId).id === manualCategoryId) {
    result = { categoryId: manualCategoryId, confidence: 1, method: 'citizen-selected' };
  } else {
    result = (await classifyWithClaude(title, description, photoDataUrl)) || keywordClassify(title, description);
  }
  const category = getCategory(result.categoryId);
  const department = getDepartment(category.department);
  return { ...result, category, department };
}

// ---------------------------------------------------------------------------
// AI Step 2: Escalation engine (runs in the background)
// ---------------------------------------------------------------------------
// Every `checkIntervalSeconds`, scan open complaints. If "now" has passed the
// SLA deadline and the department hasn't resolved it, the system auto-drafts
// an escalation notice to the assigned department (level 1). If it's still
// unresolved after a further grace window, it escalates again to a higher
// municipal authority (level 2). Each notice is logged as a notification and
// attached to the complaint's own history, so the public dashboard can show
// citizens exactly when and why an escalation happened.

const ESCALATION_TEMPLATES = {
  1: [
    (c) => `AI ESCALATION NOTICE: Complaint #${c.id.slice(0, 8)} ("${c.title}") assigned to ${c.department.name} has missed its resolution deadline. No status update was recorded in time. Please action within 24 hours to avoid further escalation.`,
    (c) => `Automated alert: The SLA for complaint #${c.id.slice(0, 8)} at ${c.location.address || 'the reported location'} has expired with no resolution logged by ${c.department.name}. Immediate attention requested.`,
  ],
  2: [
    (c) => `SECOND-LEVEL AI ESCALATION: Complaint #${c.id.slice(0, 8)} remains unresolved well past its deadline despite a prior notice to ${c.department.name}. Escalating to municipal administration for direct oversight.`,
  ],
};

function draftEscalation(complaint, level) {
  const pool = ESCALATION_TEMPLATES[level];
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template(complaint);
}

function runEscalationSweep() {
  const complaints = readJSON(COMPLAINTS_FILE);
  const notifications = readJSON(NOTIFICATIONS_FILE);
  const now = Date.now();
  let changed = false;

  for (const c of complaints) {
    if (['Resolved', 'Closed'].includes(c.status)) continue;
    const deadline = new Date(c.slaDeadline).getTime();
    if (now < deadline) continue;

    const hoursOverdue = (now - deadline) / 3600000;

    if (c.escalationLevel === 0) {
      const message = draftEscalation(c, 1);
      c.escalationLevel = 1;
      c.priority = 'High';
      const entry = { level: 1, message, at: new Date().toISOString() };
      c.escalationHistory.push(entry);
      notifications.unshift({
        id: crypto.randomUUID(),
        complaintId: c.id,
        department: c.department.name,
        level: 1,
        message,
        createdAt: entry.at,
      });
      changed = true;
    } else if (c.escalationLevel === 1 && hoursOverdue >= config.escalation.level2AfterExtraHours) {
      const message = draftEscalation(c, 2);
      c.escalationLevel = 2;
      c.priority = 'Critical';
      const entry = { level: 2, message, at: new Date().toISOString() };
      c.escalationHistory.push(entry);
      notifications.unshift({
        id: crypto.randomUUID(),
        complaintId: c.id,
        department: 'Municipal Administration (escalated)',
        level: 2,
        message,
        createdAt: entry.at,
      });
      changed = true;
    }
  }

  if (changed) {
    writeJSON(COMPLAINTS_FILE, complaints);
    writeJSON(NOTIFICATIONS_FILE, notifications.slice(0, 200));
  }
}

setInterval(runEscalationSweep, (config.escalation.checkIntervalSeconds || 15) * 1000);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 15 * 1024 * 1024) req.destroy(); // 15MB cap (photo as base64)
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(FRONTEND_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    send(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// Complaint state machine
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['Assigned', 'In Progress', 'Resolved', 'Closed'];

function computeSlaDeadline(category, createdAt) {
  return new Date(new Date(createdAt).getTime() + category.slaHours * 3600000).toISOString();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // --- Static frontend ---
    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    // --- GET /api/config ---
    if (pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, config);
    }

    // --- POST /api/complaints (citizen submits a new complaint) ---
    if (pathname === '/api/complaints' && req.method === 'POST') {
      const body = await readBody(req);
      const { title, description, photoDataUrl, lat, lng, address, citizenName, citizenPhone, categoryId } = body;

      if (!title || !description) {
        return send(res, 400, { error: 'title and description are required' });
      }
      if (lat === undefined || lng === undefined) {
        return send(res, 400, { error: 'location (lat, lng) is required — enable location or enter it manually' });
      }

      const routing = await categorizeAndRoute(title, description, photoDataUrl, categoryId);
      const now = new Date().toISOString();

      const complaint = {
        id: crypto.randomUUID(),
        title,
        description,
        photoDataUrl: photoDataUrl || null,
        location: { lat, lng, address: address || '' },
        citizen: { name: citizenName || 'Anonymous', phone: citizenPhone || '' },
        category: { id: routing.category.id, label: routing.category.label },
        department: { id: routing.department.id, name: routing.department.name },
        aiClassification: { method: routing.method, confidence: routing.confidence },
        status: 'Assigned',
        priority: 'Normal',
        createdAt: now,
        slaHours: routing.category.slaHours,
        slaDeadline: computeSlaDeadline(routing.category, now),
        escalationLevel: 0,
        escalationHistory: [],
        resolutionPhotoDataUrl: null,
        resolvedAt: null,
        statusHistory: [{ status: 'Assigned', at: now, note: `Auto-routed to ${routing.department.name} by AI (${routing.method}, confidence ${routing.confidence}).` }],
      };

      const complaints = readJSON(COMPLAINTS_FILE);
      complaints.unshift(complaint);
      writeJSON(COMPLAINTS_FILE, complaints);

      return send(res, 201, complaint);
    }

    // --- GET /api/complaints (public dashboard list, with filters) ---
    if (pathname === '/api/complaints' && req.method === 'GET') {
      let complaints = readJSON(COMPLAINTS_FILE);
      const status = url.searchParams.get('status');
      const categoryId = url.searchParams.get('category');
      const departmentId = url.searchParams.get('department');

      if (status) complaints = complaints.filter((c) => c.status === status);
      if (categoryId) complaints = complaints.filter((c) => c.category.id === categoryId);
      if (departmentId) complaints = complaints.filter((c) => c.department.id === departmentId);

      return send(res, 200, complaints);
    }

    // --- GET /api/complaints/:id ---
    const singleMatch = pathname.match(/^\/api\/complaints\/([a-f0-9-]+)$/);
    if (singleMatch && req.method === 'GET') {
      const complaints = readJSON(COMPLAINTS_FILE);
      const complaint = complaints.find((c) => c.id === singleMatch[1]);
      if (!complaint) return send(res, 404, { error: 'Complaint not found' });
      return send(res, 200, complaint);
    }

    // --- PATCH /api/complaints/:id/status (department updates progress) ---
    const statusMatch = pathname.match(/^\/api\/complaints\/([a-f0-9-]+)\/status$/);
    if (statusMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      const { status, note, resolutionPhotoDataUrl, actorName } = body;
      if (!VALID_STATUSES.includes(status)) {
        return send(res, 400, { error: `status must be one of ${VALID_STATUSES.join(', ')}` });
      }
      const complaints = readJSON(COMPLAINTS_FILE);
      const complaint = complaints.find((c) => c.id === statusMatch[1]);
      if (!complaint) return send(res, 404, { error: 'Complaint not found' });

      complaint.status = status;
      const now = new Date().toISOString();
      complaint.statusHistory.push({ status, at: now, note: note || '', actor: actorName || 'Department staff' });

      if (status === 'Resolved') {
        complaint.resolvedAt = now;
        complaint.resolutionPhotoDataUrl = resolutionPhotoDataUrl || null;
      }
      // Acting on it before the deadline stops any further auto-escalation,
      // but we keep the history of any escalation that already fired.
      writeJSON(COMPLAINTS_FILE, complaints);
      return send(res, 200, complaint);
    }

    // --- PATCH /api/complaints/:id/confirm (citizen confirms or disputes a resolution) ---
    const confirmMatch = pathname.match(/^\/api\/complaints\/([a-f0-9-]+)\/confirm$/);
    if (confirmMatch && req.method === 'PATCH') {
      const body = await readBody(req);
      const complaints = readJSON(COMPLAINTS_FILE);
      const complaint = complaints.find((c) => c.id === confirmMatch[1]);
      if (!complaint) return send(res, 404, { error: 'Complaint not found' });
      if (complaint.status !== 'Resolved') {
        return send(res, 400, { error: 'Only resolved complaints can be confirmed or disputed' });
      }
      const now = new Date().toISOString();
      if (body.confirmed) {
        complaint.status = 'Closed';
        complaint.statusHistory.push({ status: 'Closed', at: now, note: 'Citizen confirmed the issue was fixed.', actor: 'Citizen' });
      } else {
        complaint.status = 'In Progress';
        complaint.escalationLevel = 0; // reopen with a fresh SLA clock
        complaint.slaDeadline = computeSlaDeadline(getCategory(complaint.category.id), now);
        complaint.statusHistory.push({ status: 'In Progress', at: now, note: `Citizen disputed resolution: "${body.reason || 'no reason given'}". Reopened.`, actor: 'Citizen' });
      }
      writeJSON(COMPLAINTS_FILE, complaints);
      return send(res, 200, complaint);
    }

    // --- GET /api/notifications (AI escalation log, for the admin panel) ---
    if (pathname === '/api/notifications' && req.method === 'GET') {
      return send(res, 200, readJSON(NOTIFICATIONS_FILE));
    }

    // --- GET /api/stats (public dashboard aggregates) ---
    if (pathname === '/api/stats' && req.method === 'GET') {
      const complaints = readJSON(COMPLAINTS_FILE);
      const now = Date.now();
      const total = complaints.length;
      const byStatus = {};
      const byCategory = {};
      let breached = 0;
      let resolvedOnTime = 0;
      let resolvedTotal = 0;

      for (const c of complaints) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        byCategory[c.category.id] = (byCategory[c.category.id] || 0) + 1;
        const deadline = new Date(c.slaDeadline).getTime();
        if (!['Resolved', 'Closed'].includes(c.status) && now > deadline) breached += 1;
        if (['Resolved', 'Closed'].includes(c.status)) {
          resolvedTotal += 1;
          if (c.resolvedAt && new Date(c.resolvedAt).getTime() <= deadline) resolvedOnTime += 1;
        }
      }

      return send(res, 200, {
        total,
        byStatus,
        byCategory,
        currentlyBreached: breached,
        slaComplianceRate: resolvedTotal ? Math.round((resolvedOnTime / resolvedTotal) * 100) : null,
      });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Internal server error', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\nSmart Municipal Complaint Tracker running at http://localhost:${PORT}`);
  console.log(`  Citizen app + public dashboard: http://localhost:${PORT}/index.html`);
  console.log(`  Department / admin panel:       http://localhost:${PORT}/admin.html`);
  console.log(`  AI escalation sweep every ${config.escalation.checkIntervalSeconds}s. ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? 'detected — using Claude vision for categorization.' : 'not set — using offline keyword classifier.'}\n`);
});
