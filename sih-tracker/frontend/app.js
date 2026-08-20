// ============================================================================
// CivicDocket — citizen portal logic (report form + public dashboard)
// ============================================================================

const API = '/api';
let CONFIG = null;
let photoDataUrl = null;

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') loadDashboard();
  });
});

// ---------- Load config (categories / departments) ----------
async function loadConfig() {
  const res = await fetch(`${API}/config`);
  CONFIG = await res.json();

  const categorySelect = document.getElementById('category');
  const filterCategory = document.getElementById('filterCategory');
  const filterDepartment = document.getElementById('filterDepartment');

  CONFIG.categories.forEach((c) => {
    if (categorySelect) {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.label;
      categorySelect.appendChild(opt);
    }
    if (filterCategory) {
      const opt2 = document.createElement('option');
      opt2.value = c.id; opt2.textContent = c.label;
      filterCategory.appendChild(opt2);
    }
  });

  CONFIG.departments.forEach((d) => {
    if (filterDepartment) {
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = d.name;
      filterDepartment.appendChild(opt);
    }
  });
}

// ---------- Photo upload -> base64 preview ----------
const photoInput = document.getElementById('photo');
if (photoInput) {
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      photoDataUrl = reader.result;
      const preview = document.getElementById('photoPreview');
      preview.src = photoDataUrl;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Geolocation ----------
const useLocationBtn = document.getElementById('useLocationBtn');
if (useLocationBtn) {
  useLocationBtn.addEventListener('click', () => {
    const status = document.getElementById('locStatus');
    if (!navigator.geolocation) {
      status.textContent = 'Geolocation not supported — enter coordinates manually.';
      return;
    }
    status.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById('lat').value = pos.coords.latitude.toFixed(6);
        document.getElementById('lng').value = pos.coords.longitude.toFixed(6);
        status.textContent = 'Location captured.';
      },
      () => { status.textContent = 'Could not get location — enter coordinates manually.'; }
    );
  });
}

// ---------- Submit complaint ----------
const reportForm = document.getElementById('reportForm');
if (reportForm) {
  reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const lat = parseFloat(document.getElementById('lat').value);
    const lng = parseFloat(document.getElementById('lng').value);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      alert('Please set a location (use the button or enter coordinates manually).');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit complaint';
      return;
    }

    const payload = {
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      categoryId: document.getElementById('category').value || undefined,
      photoDataUrl,
      lat, lng,
      address: document.getElementById('address').value,
      citizenName: document.getElementById('citizenName').value,
      citizenPhone: document.getElementById('citizenPhone').value,
    };

    try {
      const res = await fetch(`${API}/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed');

      renderConfirmation(data);
      reportForm.reset();
      document.getElementById('photoPreview').style.display = 'none';
      photoDataUrl = null;
    } catch (err) {
      alert(`Could not submit complaint: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit complaint';
    }
  });
}

function renderConfirmation(c) {
  const box = document.getElementById('confirmationTicket');
  const deadline = new Date(c.slaDeadline).toLocaleString();
  box.innerHTML = `
    <h3>Docket #${c.id.slice(0, 8)} filed</h3>
    <dl class="kv">
      <dt>Category</dt><dd>${c.category.label} (${c.aiClassification.method}, ${Math.round(c.aiClassification.confidence * 100)}% confidence)</dd>
      <dt>Routed to</dt><dd>${c.department.name}</dd>
      <dt>Status</dt><dd>${c.status}</dd>
      <dt>Resolution due</dt><dd>${deadline}</dd>
    </dl>
    <p class="hint" style="margin-top:10px;">If ${c.department.name} takes no action by the deadline, the system will automatically draft and log an escalation notice — check the Public Ledger tab to follow this docket.</p>
  `;
  box.style.display = 'block';
}

// ---------- Dashboard ----------
let dashboardTimer = null;
let slaTickTimer = null;

async function loadDashboard() {
  await loadStats();
  await loadComplaints();
  if (!dashboardTimer) dashboardTimer = setInterval(() => { loadStats(); loadComplaints(); }, 20000);
  if (!slaTickTimer) slaTickTimer = setInterval(updateSlaLines, 1000);
}

async function loadStats() {
  const res = await fetch(`${API}/stats`);
  const s = await res.json();
  document.getElementById('statTotal').textContent = s.total;
  const open = Object.entries(s.byStatus).filter(([k]) => !['Resolved', 'Closed'].includes(k)).reduce((a, [, v]) => a + v, 0);
  document.getElementById('statOpen').textContent = open;
  document.getElementById('statBreach').textContent = s.currentlyBreached;
  document.getElementById('statCompliance').textContent = s.slaComplianceRate === null ? '—' : `${s.slaComplianceRate}%`;
}

document.getElementById('filterStatus')?.addEventListener('change', loadComplaints);
document.getElementById('filterCategory')?.addEventListener('change', loadComplaints);
document.getElementById('filterDepartment')?.addEventListener('change', loadComplaints);
document.getElementById('refreshBtn')?.addEventListener('click', () => { loadStats(); loadComplaints(); });

async function loadComplaints() {
  const status = document.getElementById('filterStatus').value;
  const category = document.getElementById('filterCategory').value;
  const department = document.getElementById('filterDepartment').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  if (department) params.set('department', department);

  const res = await fetch(`${API}/complaints?${params.toString()}`);
  const complaints = await res.json();
  renderDocketList(complaints);
}

function statusStampClass(status) {
  return { Assigned: 'assigned', 'In Progress': 'progress', Resolved: 'resolved', Closed: 'closed' }[status] || 'assigned';
}

function renderDocketList(complaints) {
  const list = document.getElementById('docketList');
  if (!complaints.length) {
    list.innerHTML = '<div class="empty-state">No complaints match these filters yet.</div>';
    return;
  }

  list.innerHTML = complaints.map((c) => {
    const isDone = ['Resolved', 'Closed'].includes(c.status);
    const breached = !isDone && Date.now() > new Date(c.slaDeadline).getTime();
    return `
    <div class="docket ${breached ? 'breach' : ''} ${isDone ? 'resolved' : ''}" data-id="${c.id}" data-deadline="${c.slaDeadline}" data-done="${isDone}">
      <div class="docket-top">
        <div>
          <div class="docket-id">DOCKET #${c.id.slice(0, 8)} · ${new Date(c.createdAt).toLocaleDateString()}</div>
          <div class="docket-title">${escapeHtml(c.title)}</div>
          <div class="docket-meta">
            <span>${c.category.label}</span>
            <span>→ ${c.department.name}</span>
            ${c.location.address ? `<span>${escapeHtml(c.location.address)}</span>` : ''}
          </div>
        </div>
        <span class="stamp ${statusStampClass(c.status)}">${c.status}</span>
      </div>

      <div class="sla-line" data-sla></div>
      ${c.escalationLevel > 0 ? `<div class="esc-flag">⚠ AI escalated (level ${c.escalationLevel}) — no action taken before deadline</div>` : ''}

      <div class="docket-detail">
        ${c.photoDataUrl ? `<img class="docket-photo" src="${c.photoDataUrl}" alt="reported issue" />` : ''}
        <p style="font-size:13px; margin:0 0 12px;">${escapeHtml(c.description)}</p>

        ${c.escalationHistory && c.escalationHistory.length ? `
          <p class="hint" style="margin-bottom:6px;">AI escalation log</p>
          <ul class="history escalation">
            ${c.escalationHistory.map((h) => `<li>${escapeHtml(h.message)}<br><span class="h-time">${new Date(h.at).toLocaleString()}</span></li>`).join('')}
          </ul>
        ` : ''}

        <p class="hint" style="margin-bottom:6px;">Status history</p>
        <ul class="history">
          ${c.statusHistory.map((h) => `<li><span class="h-status">${h.status}</span> — ${escapeHtml(h.note || '')}<br><span class="h-time">${new Date(h.at).toLocaleString()} · ${escapeHtml(h.actor || '')}</span></li>`).join('')}
        </ul>

        ${c.status === 'Resolved' ? `
          <div class="action-row">
            <button class="btn btn-sm" onclick="confirmResolution('${c.id}', true)">Confirm fixed</button>
            <button class="btn btn-outline btn-sm" onclick="confirmResolution('${c.id}', false)">Dispute — not actually fixed</button>
          </div>
        ` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.docket').forEach((el) => {
    el.querySelector('.docket-top').addEventListener('click', () => el.classList.toggle('open'));
  });

  updateSlaLines();
}

function updateSlaLines() {
  document.querySelectorAll('.docket').forEach((el) => {
    const line = el.querySelector('[data-sla]');
    if (!line) return;
    const done = el.dataset.done === 'true';
    if (done) {
      line.className = 'sla-line done';
      line.innerHTML = `<span class="dot"></span> Closed out of the SLA clock`;
      return;
    }
    const deadline = new Date(el.dataset.deadline).getTime();
    const diff = deadline - Date.now();
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const s = Math.floor((abs % 60000) / 1000);
    const label = `${h}h ${m}m ${s}s`;

    if (diff < 0) {
      line.className = 'sla-line breach';
      line.innerHTML = `<span class="dot"></span> SLA breached ${label} ago`;
    } else if (diff < 6 * 3600000) {
      line.className = 'sla-line warn';
      line.innerHTML = `<span class="dot"></span> Due soon — ${label} remaining`;
    } else {
      line.className = 'sla-line';
      line.innerHTML = `<span class="dot"></span> ${label} remaining until SLA deadline`;
    }
  });
}

async function confirmResolution(id, confirmed) {
  let reason = '';
  if (!confirmed) reason = prompt('What is still wrong? (helps the department)') || '';
  await fetch(`${API}/complaints/${id}/confirm`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed, reason }),
  });
  loadStats();
  loadComplaints();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

loadConfig();
