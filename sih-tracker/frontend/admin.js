// ============================================================================
// CivicDocket — department/admin panel logic
// ============================================================================

const API = '/api';
let CONFIG = null;
let resolutionPhotoDataUrl = {}; // keyed by complaint id, set via inline file input

async function loadConfig() {
  const res = await fetch(`${API}/config`);
  CONFIG = await res.json();
  const deptSelect = document.getElementById('deptSelect');
  CONFIG.departments.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.id; opt.textContent = d.name;
    deptSelect.appendChild(opt);
  });
}

document.getElementById('deptSelect').addEventListener('change', loadQueue);
document.getElementById('statusSelect').addEventListener('change', loadQueue);
document.getElementById('refreshBtn').addEventListener('click', () => { loadNotifications(); loadQueue(); });

async function loadNotifications() {
  const res = await fetch(`${API}/notifications`);
  const notifs = await res.json();
  const feed = document.getElementById('notifFeed');
  if (!notifs.length) {
    feed.innerHTML = '<div class="empty-state">No escalations yet — complaints are being actioned within their SLA.</div>';
    return;
  }
  feed.innerHTML = notifs.slice(0, 15).map((n) => `
    <div class="notif-item">
      <strong>Level ${n.level} escalation</strong> → ${escapeHtml(n.department)}<br>
      ${escapeHtml(n.message)}
      <span class="n-time">${new Date(n.createdAt).toLocaleString()}</span>
    </div>
  `).join('');
}

async function loadQueue() {
  const department = document.getElementById('deptSelect').value;
  const status = document.getElementById('statusSelect').value;
  const params = new URLSearchParams();
  if (department) params.set('department', department);
  if (status) params.set('status', status);

  const res = await fetch(`${API}/complaints?${params.toString()}`);
  const complaints = await res.json();
  renderQueue(complaints.filter((c) => !status ? c.status !== 'Closed' : true));
}

function statusStampClass(status) {
  return { Assigned: 'assigned', 'In Progress': 'progress', Resolved: 'resolved', Closed: 'closed' }[status] || 'assigned';
}

function renderQueue(complaints) {
  const list = document.getElementById('queueList');
  if (!complaints.length) {
    list.innerHTML = '<div class="empty-state">No complaints in this queue.</div>';
    return;
  }

  list.innerHTML = complaints.map((c) => {
    const isDone = ['Resolved', 'Closed'].includes(c.status);
    const breached = !isDone && Date.now() > new Date(c.slaDeadline).getTime();
    return `
    <div class="docket ${breached ? 'breach' : ''} ${isDone ? 'resolved' : ''}" data-deadline="${c.slaDeadline}" data-done="${isDone}">
      <div class="docket-top">
        <div>
          <div class="docket-id">DOCKET #${c.id.slice(0, 8)} · ${c.citizen.name}${c.citizen.phone ? ' · ' + escapeHtml(c.citizen.phone) : ''}</div>
          <div class="docket-title">${escapeHtml(c.title)}</div>
          <div class="docket-meta">
            <span>${c.category.label}</span>
            <span>${c.department.name}</span>
            ${c.location.address ? `<span>${escapeHtml(c.location.address)}</span>` : `<span>${c.location.lat.toFixed(4)}, ${c.location.lng.toFixed(4)}</span>`}
          </div>
        </div>
        <span class="stamp ${statusStampClass(c.status)}">${c.status}</span>
      </div>

      <div class="sla-line" data-sla></div>
      ${c.escalationLevel > 0 ? `<div class="esc-flag">⚠ AI escalated (level ${c.escalationLevel}) — action overdue</div>` : ''}

      <div style="margin-top:12px; font-size:13px;">${escapeHtml(c.description)}</div>
      ${c.photoDataUrl ? `<img class="docket-photo" style="margin-top:10px;" src="${c.photoDataUrl}" alt="reported issue" />` : ''}

      <div class="action-row">
        ${c.status === 'Assigned' ? `<button class="btn btn-sm" onclick="updateStatus('${c.id}', 'In Progress')">Mark In Progress</button>` : ''}
        ${c.status === 'In Progress' ? `
          <input type="file" accept="image/*" id="resphoto-${c.id}" style="max-width:220px;" onchange="captureResolutionPhoto('${c.id}', this)" />
          <button class="btn btn-sm" onclick="updateStatus('${c.id}', 'Resolved')">Mark Resolved</button>
        ` : ''}
        ${!isDone ? `<span class="hint">Acting now stops any further AI escalation on this docket.</span>` : ''}
      </div>
    </div>`;
  }).join('');

  updateSlaLines();
}

function captureResolutionPhoto(id, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { resolutionPhotoDataUrl[id] = reader.result; };
  reader.readAsDataURL(file);
}

async function updateStatus(id, status) {
  const body = { status, actorName: 'Department staff' };
  if (status === 'Resolved') {
    body.resolutionPhotoDataUrl = resolutionPhotoDataUrl[id] || null;
    body.note = 'Marked resolved by department.';
  } else {
    body.note = 'Department began work on this complaint.';
  }
  await fetch(`${API}/complaints/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  loadQueue();
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
    const label = `${h}h ${m}m`;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

(async function init() {
  await loadConfig();
  await loadNotifications();
  await loadQueue();
  setInterval(loadNotifications, 15000);
  setInterval(loadQueue, 20000);
  setInterval(updateSlaLines, 1000);
})();
