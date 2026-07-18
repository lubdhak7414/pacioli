// DOM refs
const chatMessages    = document.getElementById("chatMessages");
const chatForm        = document.getElementById("chatForm");
const chatInput       = document.getElementById("chatInput");
const sendBtn         = document.getElementById("sendBtn");
const proposalEmpty   = document.getElementById("proposalEmpty");
const proposalContent = document.getElementById("proposalContent");
const searchInput     = document.getElementById("searchInput");
const searchCount     = document.getElementById("searchCount");
const charCount       = document.getElementById("charCount");

var currentProposalId = null;
var historyOpen = false;
var _confirmTimeout = null;
var _pendingHighlight = null;
var _isPinnedToBottom = true;
var selectedDate = null;

// ── Session persistence ──────────────────────────────────────────
function saveSession() {
  try {
    sessionStorage.setItem("pacioli_proposalId", currentProposalId || "");
    sessionStorage.setItem("pacioli_historyOpen", historyOpen ? "1" : "0");
    sessionStorage.setItem("pacioli_selectedDate", selectedDate || "");
  } catch (e) {}
}

function loadSession() {
  try {
    var pid = sessionStorage.getItem("pacioli_proposalId");
    if (pid) currentProposalId = parseInt(pid) || null;
    historyOpen = sessionStorage.getItem("pacioli_historyOpen") === "1";
    var sd = sessionStorage.getItem("pacioli_selectedDate");
    if (sd) selectedDate = sd;
  } catch (e) {}
}

// Track scroll position — only auto-scroll when user is near the bottom
chatMessages.addEventListener("scroll", function() {
  var threshold = 80;
  _isPinnedToBottom = chatMessages.scrollTop + chatMessages.clientHeight >= chatMessages.scrollHeight - threshold;
});

// ── Auth ─────────────────────────────────────────────────────────
function getApiKey() {
  return localStorage.getItem("pacioli_api_key") || "";
}

function setApiKey(key) {
  localStorage.setItem("pacioli_api_key", key);
}

function authHeaders() {
  var key = getApiKey();
  return key ? { "X-API-Key": key } : {};
}

// Wrapper around fetch that adds auth headers
async function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {}, authHeaders());
  var res = await fetch(url, opts);
  if (res.status === 401) {
    showAuthModal();
    throw new Error("Authentication required");
  }
  return res;
}

function showAuthModal() {
  var existing = document.getElementById("authModal");
  if (existing) return;
  var modal = document.createElement("div");
  modal.id = "authModal";
  modal.className = "modal-overlay";
  modal.innerHTML =
    '<div class="modal-content">' +
      '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Enter API Key</h3>' +
      '<p class="text-xs mb-3" style="color: var(--text-muted);">This instance requires authentication. Enter the API key to continue.</p>' +
      '<input id="authKeyInput" type="password" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-3" ' +
        'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" ' +
        'placeholder="API key" autofocus />' +
      '<div class="flex gap-2">' +
        '<button onclick="submitAuthKey()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Connect</button>' +
        '<button onclick="document.getElementById(\'authModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);
  document.getElementById("authKeyInput").focus();
}

function submitAuthKey() {
  var input = document.getElementById("authKeyInput");
  var key = input ? input.value.trim() : "";
  if (!key) return;
  setApiKey(key);
  document.getElementById("authModal").remove();
  showToast("Connected", "success");
  checkHealth();
}

// Check if auth is needed on load
(async function() {
  try {
    var res = await fetch("/api/health");
    if (res.status === 401 && !getApiKey()) {
      showAuthModal();
    }
  } catch (e) {}
})();

// ── Markdown renderer (lightweight) ────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  var lines = text.split("\n");
  var html = "";
  var inTable = false;
  var inList = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Table row
    if (line.trim().match(/^\|(.+)\|$/)) {
      var trimmed = line.trim();
      // Skip separator rows like |---|---|
      if (trimmed.match(/^\|[\s\-:|]+\|$/)) continue;
      if (!inTable) {
        html += "<table>";
        inTable = true;
        inList = false;
      }
      var cells = trimmed.slice(1, -1).split("|").map(function(c) { return c.trim(); });
      var isHeader = (i + 1 < lines.length && lines[i + 1].trim().match(/^\|[\s\-:|]+\|$/));
      var tag = isHeader ? "th" : "td";
      html += "<tr>" + cells.map(function(c) { return "<" + tag + ">" + escHtml(c) + "</" + tag + ">"; }).join("") + "</tr>";
      continue;
    } else if (inTable) {
      html += "</table>";
      inTable = false;
    }

    // Blank line
    if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
      continue;
    }

    // Headings
    var hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      var level = hMatch[1].length;
      html += "<h" + level + ">" + inlineMd(hMatch[2]) + "</h" + level + ">";
      continue;
    }

    // Horizontal rule
    if (line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      html += "<hr>";
      continue;
    }

    // List item
    var liMatch = line.match(/^[\s]*[-*]\s+(.+)/);
    if (liMatch) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inlineMd(liMatch[1]) + "</li>";
      continue;
    }

    // Regular paragraph
    if (inList) { html += "</ul>"; inList = false; }
    html += "<p>" + inlineMd(line) + "</p>";
  }
  if (inTable) html += "</table>";
  if (inList) html += "</ul>";
  return html;
}

function inlineMd(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

// Utilities
function escHtml(s) {
  var d = document.createElement("div");
  d.textContent = String(s == null ? "" : s);
  return d.innerHTML;
}

// Toast notifications
function showToast(message, type, onUndo) {
  var styles = {
    success: "background: #16a34a; box-shadow: 0 4px 12px rgba(22,163,74,0.25);",
    error: "background: #e11d48; box-shadow: 0 4px 12px rgba(225,29,72,0.2);",
    info: "background: #0d9488; box-shadow: 0 4px 12px rgba(13,148,136,0.25);",
  };
  var icons  = { success: "&#10003;", error: "&#10005;", info: "&#9432;" };
  var el = document.createElement("div");
  el.className = "toast fixed bottom-6 right-6 text-white px-4 py-3 rounded-xl text-sm z-50 flex items-center gap-2 font-medium";
  el.style.cssText = styles[type] || styles.info;
  var undoHtml = onUndo
    ? '<button class="underline ml-2 text-xs opacity-80 hover:opacity-100 toast-undo">Undo</button>'
    : "";
  el.innerHTML = "<span>" + (icons[type] || icons.info) + "</span><span>" + escHtml(message) + "</span>" + undoHtml;
  document.body.appendChild(el);
  var timerId = setTimeout(function() { el.remove(); }, onUndo ? 8000 : 3000);
  if (onUndo) {
    el.querySelector(".toast-undo").addEventListener("click", function() {
      clearTimeout(timerId);
      el.remove();
      onUndo();
    });
  }
}

// Status badge
function statusBadge(status) {
  var map = {
    pending:  "badge-pending",
    executed: "badge-executed",
    approved: "badge-approved",
    rejected: "badge-rejected",
    failed:   "badge-failed",
  };
  var cls = map[status] || "bg-gray-500/20 text-gray-400";
  return '<span class="ml-1 text-xs font-mono px-2 py-0.5 rounded-full ' + cls + '">' + escHtml(status) + '</span>';
}

// Add message to chat
function addMessage(role, text, proposalId, skipHidePrompts) {
  // Hide example prompts once the conversation starts (but not on history load)
  if (!skipHidePrompts && role === "user") {
    var examples = document.getElementById("examplePromptsWrap");
    if (examples) examples.style.display = "none";
  }

  var isUser = role === "user";
  var wrapper = document.createElement("div");
  wrapper.className = "fade-up flex gap-3 msg-wrapper " + (isUser ? "justify-end" : "");
  wrapper.dataset.text = String(text).toLowerCase();

  var contentHtml = "";
  if (isUser) {
    contentHtml = '<div class="bubble-user px-4 py-3 max-w-[85%] text-sm">' + escHtml(text) + '</div>';
  } else {
    var isError = /\b(validation|error|failed|couldn.t|trouble|timed out)\b/i.test(text);
    var bubbleClass = isError ? "bubble-error" : "bubble-assistant";
    var icon = isError ? '<span class="mr-1 shrink-0">&#9888;&#65039;</span>' : "";
    var badge = proposalId
      ? '<span class="ml-2 badge-pending text-xs font-mono px-2 py-0.5 rounded-full inline-block">#' + proposalId + '</span>'
      : "";
    var rendered = renderMarkdown(text);
    contentHtml =
      '<div class="w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5" style="background: var(--primary-light); color: var(--primary);">AI</div>' +
      '<div class="' + bubbleClass + ' px-4 py-3 max-w-[85%] text-sm">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<div class="flex-1 md-content">' + icon + rendered + badge + '</div>' +
          '<button class="copy-btn shrink-0 text-gray-600 hover:text-gray-300 text-xs px-1 py-0.5 rounded transition" onclick="copyMessage(this)" title="Copy to clipboard">&#128203;</button>' +
        '</div>' +
      '</div>';
  }

  wrapper.innerHTML = contentHtml;
  chatMessages.appendChild(wrapper);
  if (_isPinnedToBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

// Copy message to clipboard
function copyMessage(btn) {
  var msgEl = btn.closest(".msg-wrapper");
  var textEl = msgEl.querySelector(".md-content") || msgEl.querySelector("[class*='rounded-xl']");
  if (!textEl) return;
  var text = textEl.innerText || textEl.textContent;
  navigator.clipboard.writeText(text).then(function() {
    showToast("Copied to clipboard", "success");
  }).catch(function() {
    showToast("Failed to copy to clipboard", "error");
  });
}

// Show example prompts (help button)
function showExamples() {
  var wrap = document.getElementById("examplePromptsWrap");
  if (wrap) {
    wrap.style.display = wrap.style.display === "none" ? "" : "none";
  }
}

// Loading state
var _t10, _t60, _requestAborted;
function showLoading() {
  _requestAborted = false;
  sendBtn.disabled = true;
  chatInput.disabled = true;

  _t10 = setTimeout(function() {
    var cap = document.getElementById("typingCaption");
    if (cap) { cap.textContent = "Still thinking…"; cap.classList.remove("hidden"); }
  }, 10000);

  _t60 = setTimeout(function() {
    _requestAborted = true;
    hideLoading();
    hideTyping();
    addMessage("assistant", "The request is taking too long. Please try again.");
  }, 60000);
}

function hideLoading() {
  clearTimeout(_t10);
  clearTimeout(_t60);
  sendBtn.disabled = false;
  chatInput.disabled = false;
}

// Typing indicator
function showTyping() {
  var el = document.createElement("div");
  el.id = "typingIndicator";
  el.className = "fade-up flex gap-3";
  el.innerHTML =
    '<div class="w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0" style="background: rgba(59,130,246,0.15); color: #60a5fa;">AI</div>' +
    '<div class="bubble-assistant px-4 py-3 flex items-center">' +
      '<span class="typing-dot inline-block w-2 h-2 bg-gray-500 rounded-full mr-1"></span>' +
      '<span class="typing-dot inline-block w-2 h-2 bg-gray-500 rounded-full mr-1"></span>' +
      '<span class="typing-dot inline-block w-2 h-2 bg-gray-500 rounded-full"></span>' +
      '<span id="typingCaption" class="text-xs text-gray-500 ml-2 hidden"></span>' +
    '</div>';
  chatMessages.appendChild(el);
  if (_isPinnedToBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideTyping() {
  var el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

// Example prompt buttons
function sendExample(text) {
  chatInput.value = text;
  chatForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

// Chat submit
chatForm.addEventListener("submit", async function(e) {
  e.preventDefault();
  if (sendBtn.disabled) return;
  var msg = chatInput.value.trim();
  if (!msg) return;

  // Prepend selected date if set
  if (selectedDate) {
    msg = "Date: " + selectedDate + ". " + msg;
    selectedDate = null;
    document.querySelectorAll(".date-shortcut").forEach(function(el) { el.classList.remove("active"); });
  }

  chatInput.value = "";
  addMessage("user", msg);
  showLoading();
  showTyping();

  try {
    var res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });

    hideTyping();
    hideLoading();
    if (!res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      var errMsg = errData.detail || "Server error (" + res.status + "). Please try again.";
      addMessage("assistant", errMsg);
      return;
    }
    var data = await res.json();
    if (_requestAborted) return;
    addMessage("assistant", data.assistant_message, data.proposal_id);

    // Add CSV/XLSX download buttons and interactive view for reports
    if (data.assistant_message && !data.proposal_id) {
      var lower = data.assistant_message.toLowerCase();
      var reportType = null;
      if (lower.includes("trial balance")) reportType = "trial-balance";
      else if (lower.includes("income statement") || lower.includes("profit")) reportType = "income-statement";
      else if (lower.includes("balance sheet")) reportType = "balance-sheet";
      if (reportType) {
        var wrapper = document.createElement("div");
        wrapper.className = "fade-up flex gap-3";
        wrapper.innerHTML = '<div class="w-7 h-7 shrink-0"></div>' +
          '<div class="flex gap-2 flex-wrap">' +
            '<button onclick="showInteractiveReport(\'' + reportType + '\', this)" class="btn-ghost text-xs px-3 py-1.5 rounded-lg">&#128202; Interactive</button>' +
            '<a href="/api/reports/' + reportType + '/csv" class="btn-ghost text-xs px-3 py-1.5 rounded-lg" download>&#128229; CSV</a>' +
            '<a href="/api/reports/' + reportType + '/xlsx" class="btn-ghost text-xs px-3 py-1.5 rounded-lg" download>&#128229; XLSX</a>' +
          '</div>';
        chatMessages.appendChild(wrapper);
        if (_isPinnedToBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }

    if (data.proposal_id) {
      await loadProposal(data.proposal_id);
    }
  } catch (err) {
    hideTyping();
    hideLoading();
    addMessage("assistant", "Error: Could not reach the server. Please try again.");
  }
});

// Load proposal into right panel
async function loadProposal(id) {
  _confirmStep = false;
  clearTimeout(_confirmTimeout);

  try {
    var res = await apiFetch("/api/proposals/" + id);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var p = await res.json();

    currentProposalId = p.status === "pending" ? id : null;
    saveSession();

    switchTab("proposal");
    proposalEmpty.classList.add("hidden");
    proposalContent.classList.remove("hidden");

    var actionsHtml = "";
    if (p.actions && p.actions.length > 0) {
      actionsHtml = p.actions.map(function(a) {
        var valueDisplay = "";
        if (a.old_value_display !== null && a.old_value_display !== undefined) {
          valueDisplay =
            '<div class="flex items-center gap-2 text-sm flex-wrap">' +
              '<span class="text-ledger-danger line-through">' + escHtml(a.old_value_display) + '</span>' +
              '<span class="text-gray-600">&rarr;</span>' +
              '<span class="text-ledger-success font-medium">' + escHtml(a.new_value_display) + '</span>' +
            '</div>';
        } else {
          valueDisplay =
            '<div class="text-sm">' +
              '<span class="text-gray-600">Set to:</span>' +
              '<span class="text-ledger-success font-medium ml-1">' + escHtml(a.new_value_display) + '</span>' +
            '</div>';
        }
        return (
          '<div class="proposal-card p-3">' +
            '<div class="flex items-center gap-2 mb-2 flex-wrap">' +
              '<span class="text-xs font-mono px-2 py-0.5 rounded bg-ledger-accent/10 text-ledger-accent">' + escHtml(a.operation) + '</span>' +
              '<span class="text-xs text-gray-500">' + escHtml(a.sheet) + '!' + escHtml(a.cell_ref || a.start_cell || "Row " + a.row_index) + '</span>' +
            '</div>' +
            valueDisplay +
            '<p class="text-xs text-gray-500 mt-1">' + escHtml(a.context || "") + '</p>' +
          '</div>'
        );
      }).join("");
    }

    var isPending = p.status === "pending";
    var statusHtml = isPending
      ? '<span class="inline-block w-3 h-3 rounded-full bg-ledger-warn animate-pulse"></span><span class="text-sm font-medium text-ledger-warn">Pending Approval</span>'
      : '<span class="text-sm font-medium text-gray-400">Status:</span>' + statusBadge(p.status);

    var buttonsHtml;
    if (isPending) {
      buttonsHtml = '<div id="approvalButtons" class="flex gap-3">' +
          '<button id="approveBtn" onclick="approveProposal(' + p.id + ')" class="btn-success flex-1 py-3 rounded-xl text-sm transition">Approve &amp; Execute</button>' +
          '<button onclick="rejectProposal(' + p.id + ')" class="btn-danger flex-1 py-3 rounded-xl text-sm transition">Reject</button>' +
        '</div>';
    } else if (p.status === "executed") {
      buttonsHtml = '<div id="approvalButtons">' +
          '<p class="text-sm text-gray-500 mb-2">This proposal was executed.</p>' +
          '<button onclick="restoreProposal(' + p.id + ')" class="btn-ghost w-full py-2.5 rounded-xl text-sm font-medium transition">&#8634; Undo (restore ledger to before this change)</button>' +
        '</div>';
    } else {
      buttonsHtml = '<div id="approvalButtons"><p class="text-sm text-gray-500">This proposal has already been ' + escHtml(p.status) + '.</p></div>';
    }

    var warningsHtml = "";
    if (p.validation_notes && p.validation_notes.length > 0) {
      warningsHtml =
        '<div class="mb-4 bg-ledger-warn/10 border border-ledger-warn/30 rounded-lg px-3 py-2">' +
          p.validation_notes.map(function(w) {
            return '<p class="text-xs text-ledger-warn">&#9888;&#65039; ' + escHtml(w) + '</p>';
          }).join("") +
        '</div>';
    }

    proposalContent.innerHTML =
      '<div class="fade-up">' +
        '<div class="flex items-center gap-2 mb-4">' + statusHtml + '<span class="text-xs text-gray-600 ml-auto">#' + p.id + '</span></div>' +
        warningsHtml +
        '<div class="mb-4">' +
          '<p class="text-xs text-gray-500 mb-1">Your request</p>' +
          '<p class="text-sm bg-ledger-bg border border-ledger-border rounded-lg px-3 py-2">' + escHtml(p.user_message) + '</p>' +
        '</div>' +
        '<div class="mb-4">' +
          '<p class="text-xs text-gray-500 mb-1">AI Reasoning</p>' +
          '<p class="text-sm text-gray-400">' + escHtml(p.justification || "") + '</p>' +
        '</div>' +
        '<div class="mb-6">' +
          '<p class="text-xs text-gray-500 mb-2">Proposed Changes (' + (p.actions ? p.actions.length : 0) + ')</p>' +
          '<div class="space-y-2">' + actionsHtml + '</div>' +
        '</div>' +
        buttonsHtml +
        '<div id="approvalResult" class="mt-3 hidden"></div>' +
      '</div>';

    if (isPending) {
      showToast("Proposal #" + id + " ready for review — Ctrl+Y to approve", "info");
      // Highlight changed cells in ledger preview if it's visible
      if (p.highlight_cells && Object.keys(p.highlight_cells).length > 0) {
        _pendingHighlight = p.highlight_cells;
      }
    }
  } catch (err) {
    proposalContent.innerHTML = '<p class="text-sm text-ledger-danger">Failed to load proposal #' + id + '</p>';
    proposalEmpty.classList.add("hidden");
    proposalContent.classList.remove("hidden");
  }
}

// Approve proposal with confirmation
var _approving = false;
var _confirmStep = false;
async function approveProposal(id) {
  if (_approving) return;

  // First click: show confirmation
  if (!_confirmStep) {
    _confirmStep = true;
    var btn = document.getElementById("approveBtn");
    if (btn) {
      btn.textContent = "Confirm Execute?";
      btn.className = "btn-primary flex-1 py-3 rounded-xl text-sm transition";
    }
    _confirmTimeout = setTimeout(function() {
      _confirmStep = false;
      var btn = document.getElementById("approveBtn");
      if (btn) {
        btn.textContent = "Approve & Execute";
        btn.className = "btn-success flex-1 py-3 rounded-xl text-sm transition";
      }
    }, 5000);
    return;
  }

  // Second click: execute
  clearTimeout(_confirmTimeout);
  _confirmStep = false;
  _approving = true;
  var btns = document.getElementById("approvalButtons");
  btns.innerHTML = '<p class="text-sm text-gray-500 animate-pulse">Executing...</p>';
  try {
    var res = await apiFetch("/api/proposals/" + id + "/approve", { method: "POST" });
    if (!res.ok) {
      var errBody = await res.json().catch(function() { return {}; });
      btns.innerHTML = '<p class="text-sm text-ledger-danger">Execution failed</p>';
      showToast(errBody.detail || ("Approve failed (" + res.status + ")"), "error");
      return;
    }
    var data = await res.json();
    var result = document.getElementById("approvalResult");
    result.classList.remove("hidden");

    if (data.success) {
      btns.innerHTML = '<p class="text-sm text-ledger-success font-medium">&#10003; Changes applied to ledger</p>';
      result.innerHTML =
        '<div class="text-xs text-ledger-success bg-ledger-success/10 border border-ledger-success/20 rounded-lg p-3">' +
          (data.change_log ? data.change_log.map(function(c) { return '<p>' + escHtml(c) + '</p>'; }).join("") : "Done.") +
        '</div>';
      addMessage("assistant", "Proposal #" + id + " approved — " + (data.change_log ? data.change_log.length : 0) + " cell(s) updated.", id);
      showToast("Proposal approved and executed", "success", function() { restoreProposal(id); });
      currentProposalId = null;
      saveSession();
      if (!historyOpen) toggleHistory();
      else loadHistory(true);
      loadProposal(id);
    } else {
      btns.innerHTML = '<p class="text-sm text-ledger-danger">Execution failed</p>';
      result.innerHTML = '<p class="text-xs text-ledger-danger">' + escHtml(data.message) + '</p>';
      addMessage("assistant", "Proposal #" + id + " execution failed: " + data.message);
      showToast("Execution failed", "error");
    }
  } catch (err) {
    btns.innerHTML = '<p class="text-sm text-ledger-danger">Request failed</p>';
    showToast("Could not reach the server", "error");
  } finally {
    _approving = false;
  }
}

// Reject proposal
async function rejectProposal(id) {
  var btns = document.getElementById("approvalButtons");
  btns.innerHTML = '<p class="text-sm text-gray-500 animate-pulse">Rejecting...</p>';
  try {
    var res = await apiFetch("/api/proposals/" + id + "/reject", { method: "POST" });
    if (!res.ok) {
      var errBody = await res.json().catch(function() { return {}; });
      btns.innerHTML = '<p class="text-sm text-ledger-danger">Reject failed</p>';
      showToast(errBody.detail || ("Reject failed (" + res.status + ")"), "error");
      return;
    }
    var data = await res.json();
    var result = document.getElementById("approvalResult");
    result.classList.remove("hidden");

    if (data.success) {
      btns.innerHTML = '<p class="text-sm text-gray-500">Proposal rejected. No changes made.</p>';
      addMessage("assistant", "Proposal #" + id + " rejected. No edits were made.");
      showToast("Proposal rejected", "info");
      currentProposalId = null;
      saveSession();
      if (!historyOpen) toggleHistory();
      else loadHistory(true);
      loadProposal(id);
    }
  } catch (err) {
    btns.innerHTML = '<p class="text-sm text-ledger-danger">Request failed</p>';
    showToast("Could not reach the server", "error");
  }
}

// Past proposals history panel
var _historyOffset = 0;
var _allProposals = [];

async function loadHistory(reset) {
  if (reset) { _historyOffset = 0; _allProposals = []; }
  var panel = document.getElementById("historyPanel");
  if (_historyOffset === 0) {
    panel.innerHTML = '<p class="text-xs animate-pulse" style="color: var(--text-muted);">Loading...</p>';
  }
  try {
    var res = await apiFetch("/api/proposals?limit=10&offset=" + _historyOffset);
    var data = await res.json();
    var proposals = data.proposals || [];
    var total = data.total || 0;
    _allProposals = _allProposals.concat(proposals);
    _historyOffset += proposals.length;

    if (_allProposals.length === 0) {
      panel.innerHTML = '<p class="text-xs text-gray-600">No proposals yet.</p>';
      return;
    }

    var html = _allProposals.map(function(p) {
      var truncated = p.user_message.length > 55
        ? p.user_message.slice(0, 55) + "..."
        : p.user_message;
      return (
        '<div class="history-item flex items-center gap-2 p-2 cursor-pointer text-xs" onclick="loadProposal(' + p.id + ')">' +
          '<span class="font-mono text-gray-600 shrink-0">#' + p.id + '</span>' +
          statusBadge(p.status) +
          '<span class="text-gray-400 flex-1 truncate ml-1">' + escHtml(truncated) + '</span>' +
        '</div>'
      );
    }).join("");

    if (_historyOffset < total) {
      html += '<button onclick="loadHistory()" class="w-full text-xs py-2 mt-1 rounded-lg" style="color: var(--primary);">Load more (' + _historyOffset + ' of ' + total + ')</button>';
    }

    panel.innerHTML = html;
  } catch (err) {
    panel.innerHTML = '<p class="text-xs text-ledger-danger">Failed to load history.</p>';
  }
}

function filterHistory(query) {
  var panel = document.getElementById("historyPanel");
  var items = panel.querySelectorAll(".history-item");
  var q = (query || "").toLowerCase();
  var visible = 0;
  items.forEach(function(item) {
    var text = item.textContent.toLowerCase();
    var match = !q || text.includes(q);
    item.style.display = match ? "" : "none";
    if (match) visible++;
  });
  // Show/hide load more button based on filter
  var loadMore = panel.querySelector("button");
  if (loadMore && q) loadMore.style.display = "none";
  else if (loadMore) loadMore.style.display = "";
}

function toggleHistory() {
  historyOpen = !historyOpen;
  saveSession();
  var panel = document.getElementById("historyPanel");
  var arrow = document.getElementById("historyArrow");
  if (historyOpen) {
    panel.classList.remove("hidden");
    arrow.innerHTML = "&#9660;";
    loadHistory(true);
  } else {
    panel.classList.add("hidden");
    arrow.innerHTML = "&#9654;";
  }
}

// Tabs: proposal <-> ledger
function switchTab(tab) {
  var pv = document.getElementById("proposalView");
  var lv = document.getElementById("ledgerView");
  var tp = document.getElementById("tabProposal");
  var tl = document.getElementById("tabLedger");
  var active = "border-ledger-accent";
  var idle = "border-transparent";
  if (tab === "ledger") {
    pv.classList.add("hidden");
    lv.classList.remove("hidden");
    tl.className = "px-5 py-3 font-medium border-b-2 transition " + active;
    tp.className = "px-5 py-3 font-medium border-b-2 transition " + idle;
    loadLedgerPreview();
  } else {
    lv.classList.add("hidden");
    pv.classList.remove("hidden");
    tp.className = "tab-active px-5 py-3 font-medium border-b-2 transition";
    tl.className = "px-5 py-3 font-medium border-b-2 border-transparent transition";
  }
}

// Read-only ledger preview
var ledgerSheet = "GeneralLedger";
async function loadLedgerPreview(sheet) {
  if (sheet) ledgerSheet = sheet;
  var view = document.getElementById("ledgerView");
  view.innerHTML =
    '<div class="flex items-center gap-2 text-xs text-gray-600 py-4">' +
      '<span class="typing-dot inline-block w-1.5 h-1.5 bg-gray-500 rounded-full"></span>' +
      '<span class="typing-dot inline-block w-1.5 h-1.5 bg-gray-500 rounded-full"></span>' +
      '<span class="typing-dot inline-block w-1.5 h-1.5 bg-gray-500 rounded-full"></span>' +
      '<span class="ml-1">Loading ledger...</span>' +
    '</div>';
  try {
    var res = await apiFetch("/api/ledger/preview?sheet=" + encodeURIComponent(ledgerSheet) + "&limit=100");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();

    var tabs = (data.sheets || [ledgerSheet]).map(function(s) {
      var cls = s === data.sheet
        ? "btn-primary text-xs px-3 py-1.5 rounded-lg"
        : "btn-ghost text-xs px-3 py-1.5 rounded-lg";
      return '<button onclick="loadLedgerPreview(\'' + escHtml(s) + '\')" class="' + cls + '">' + escHtml(s) + '</button>';
    }).join(" ");

    // Empty state
    if (!data.rows || data.rows.length === 0) {
      view.innerHTML =
        '<div class="flex gap-2 mb-4 flex-wrap">' + tabs + '</div>' +
        '<div class="text-center py-12 text-gray-600">' +
          '<div class="empty-state-icon mb-3">&#128203;</div>' +
          '<p class="font-medium">No data in <strong class="text-gray-400">' + escHtml(data.sheet) + '</strong></p>' +
          '<p class="text-xs mt-1 text-gray-700">Record a transaction to see it here</p>' +
        '</div>';
      return;
    }

    // Identify numeric columns by header name
    var numHeaders = /^(Debit|Credit|Balance|Amount|Rate|Total)$/i;
    var numericCols = data.headers.map(function(h) { return numHeaders.test(h); });

    var thead = '<tr>' + data.headers.map(function(h, i) {
      var cls = numericCols[i]
        ? "text-right px-2 py-1 border-b border-ledger-border font-medium sticky top-0 bg-ledger-surface"
        : "text-left px-2 py-1 border-b border-ledger-border font-medium sticky top-0 bg-ledger-surface";
      return '<th class="' + cls + '" style="color: var(--text-muted);">' + escHtml(h) + '</th>';
    }).join("") + '</tr>';

    function fmtNum(v) {
      if (v == null || v === "") return "";
      var n = parseFloat(v);
      if (isNaN(n)) return escHtml(v);
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    var tbody = data.rows.map(function(row) {
      return '<tr class="hover:bg-ledger-surface/50">' + row.map(function(cell, i) {
        if (numericCols[i]) {
          return '<td class="px-2 py-1 border-b border-ledger-border/40 font-mono text-right" style="color: var(--text-secondary); font-variant-numeric: tabular-nums;">' + fmtNum(cell) + '</td>';
        }
        return '<td class="px-2 py-1 border-b border-ledger-border/40 font-mono" style="color: var(--text-secondary);">' + escHtml(cell == null ? "" : cell) + '</td>';
      }).join("") + '</tr>';
    }).join("");

    view.innerHTML =
      '<div class="flex gap-2 mb-3 flex-wrap">' + tabs + '</div>' +
      '<div class="overflow-x-auto"><table class="w-full text-xs border-collapse min-w-[600px]">' +
        '<thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' +
      '<p class="text-xs text-gray-600 mt-3">Showing up to 100 rows. Download for the full file.</p>';

    // Apply diff highlights if a proposal is pending
    if (_pendingHighlight && _pendingHighlight[data.sheet]) {
      var cells = _pendingHighlight[data.sheet];
      var table = view.querySelector("table");
      if (table) {
        var rows = table.querySelectorAll("tbody tr");
        cells.forEach(function(cellRef) {
          var match = cellRef.match(/^([A-Z]+)(\d+)$/);
          if (!match) return;
          var colLetter = match[1];
          var rowNum = parseInt(match[2]);
          // Convert column letter to 0-based index
          var colIdx = 0;
          for (var i = 0; i < colLetter.length; i++) {
            colIdx = colIdx * 26 + (colLetter.charCodeAt(i) - 64);
          }
          colIdx -= 1; // 0-based
          var rowIdx = rowNum - 2; // -2: header is row 1, data starts at row 2, array is 0-based
          if (rowIdx >= 0 && rowIdx < rows.length) {
            var tds = rows[rowIdx].querySelectorAll("td");
            if (colIdx >= 0 && colIdx < tds.length) {
              tds[colIdx].classList.add("diff-highlight");
            }
          }
        });
      }
    }
  } catch (err) {
    view.innerHTML = '<p class="text-sm text-ledger-danger">Failed to load ledger preview.</p>';
  }
}

// Undo (restore from snapshot)
async function restoreProposal(id) {
  if (!confirm("Restore the ledger to its state before proposal #" + id + "? This overwrites the current ledger.")) return;
  try {
    var res = await apiFetch("/api/proposals/" + id + "/restore", { method: "POST" });
    var data = await res.json();
    if (res.ok && data.success) {
      showToast("Ledger restored (before #" + id + ")", "success");
      addMessage("assistant", "Ledger restored to the state before proposal #" + id + ".");
      if (!document.getElementById("ledgerView").classList.contains("hidden")) loadLedgerPreview();
      if (historyOpen) loadHistory(true);
    } else {
      showToast(data.detail || data.message || "Restore failed", "error");
    }
  } catch (err) {
    showToast("Could not reach the server", "error");
  }
}

// Message search with match count
searchInput.addEventListener("input", function() {
  var q = this.value.toLowerCase().trim();
  var msgs = chatMessages.querySelectorAll("[data-text]");
  var count = 0;
  msgs.forEach(function(el) {
    var match = !q || el.dataset.text.includes(q);
    el.style.display = match ? "" : "none";
    if (match && q) count++;
  });
  searchCount.textContent = q ? count + " match" + (count !== 1 ? "es" : "") : "";
});

// Character count
chatInput.addEventListener("input", function() {
  var len = this.value.length;
  var max = 500;
  charCount.textContent = len + " / " + max;
  if (len > 480) {
    charCount.className = "text-red-400";
  } else if (len > 400) {
    charCount.className = "text-yellow-400";
  } else {
    charCount.className = "text-gray-600";
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", function(e) {
  if (e.ctrlKey && e.key === "y") {
    e.preventDefault();
    if (currentProposalId) {
      approveProposal(currentProposalId);
    } else {
      showToast("No pending proposal to approve", "info");
    }
  } else if (e.ctrlKey && e.key === "n") {
    e.preventDefault();
    chatInput.focus();
  } else if (e.key === "Escape" && document.activeElement === chatInput) {
    chatInput.value = "";
  }
});

// Health check dot
async function checkHealth() {
  var dot = document.getElementById("healthDot");
  try {
    var res = await fetch("/api/health");
    var data = await res.json();
    dot.className = data.status === "ok"
      ? "w-2.5 h-2.5 rounded-full bg-green-500 health-pulse"
      : "w-2.5 h-2.5 rounded-full bg-yellow-500";
    dot.title = "Status: " + data.status + " | DB: " + data.database + " | Ledger: " + (data.ledger_exists ? "found" : "missing");
  } catch (e) {
    dot.className = "w-2.5 h-2.5 rounded-full bg-red-500";
    dot.title = "Server unreachable";
  }
}
checkHealth();
setInterval(checkHealth, 60000);

// Load chat history on page load
(async function() {
  try {
    var res = await apiFetch("/api/chat/history");
    var data = await res.json();
    if (data.messages && data.messages.length > 0) {
      chatMessages.innerHTML = "";
      data.messages.forEach(function(m) {
        addMessage(m.role, m.content, m.proposal_id, true);
      });
    }
  } catch (err) {
    console.error("Failed to load chat history", err);
  }
})();

// ── Draggable divider ──────────────────────────────────────
(function() {
  var divider = document.getElementById("divider");
  var leftPanel = document.getElementById("leftPanel");
  var mainLayout = document.getElementById("mainLayout");
  var dragging = false;

  divider.addEventListener("mousedown", function(e) {
    e.preventDefault();
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    var rect = mainLayout.getBoundingClientRect();
    var offsetX = e.clientX - rect.left;
    var totalWidth = rect.width;
    var pct = (offsetX / totalWidth) * 100;
    // Clamp between 25% and 75%
    pct = Math.max(25, Math.min(75, pct));
    leftPanel.style.width = pct + "%";
  });

  document.addEventListener("mouseup", function() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
})();

// ── Export Dropdown ──────────────────────────────────────────
function toggleExportMenu() {
  var menu = document.getElementById("exportMenu");
  menu.classList.toggle("hidden");
  // Inject auth key into download links
  var key = getApiKey();
  menu.querySelectorAll("a[href]").forEach(function(a) {
    var url = new URL(a.getAttribute("href"), window.location.origin);
    if (key) url.searchParams.set("key", key);
    else url.searchParams.delete("key");
    a.href = url.pathname + url.search;
  });
}
document.addEventListener("click", function(e) {
  var dropdown = document.getElementById("exportDropdown");
  var menu = document.getElementById("exportMenu");
  if (dropdown && !dropdown.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

// ── Feature 5: Date Shortcuts ──────────────────────────────

function formatDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function setDateShortcut(preset, event) {
  var today = new Date();
  var d;
  if (preset === "today") {
    d = today;
  } else if (preset === "yesterday") {
    d = new Date(today);
    d.setDate(d.getDate() - 1);
  } else if (preset === "this_week") {
    d = new Date(today);
    d.setDate(d.getDate() - d.getDay());
  } else if (preset === "last_week") {
    d = new Date(today);
    d.setDate(d.getDate() - d.getDay() - 7);
  }
  selectedDate = formatDate(d);
  saveSession();
  // Highlight active button
  document.querySelectorAll(".date-shortcut").forEach(function(el) { el.classList.remove("active"); });
  event.target.classList.add("active");
  showToast("Date set to " + selectedDate, "info");
}

function setCustomDate(input) {
  selectedDate = input.value;
  saveSession();
  document.querySelectorAll(".date-shortcut").forEach(function(el) { el.classList.remove("active"); });
  input.classList.add("active");
  showToast("Date set to " + selectedDate, "info");
}

// ── Feature 3: Quick Action Buttons ────────────────────────
var actionTemplates = [
  { label: "Record Expense", icon: "&#128176;", template: "Record a $ expense for " },
  { label: "Record Revenue", icon: "&#128178;", template: "Record $ revenue from " },
  { label: "Payment Received", icon: "&#128179;", template: "Record payment of $ received from " },
  { label: "Payment Made", icon: "&#128179;", template: "Record payment of $ made to " },
  { label: "Balance Sheet", icon: "&#128202;", template: "Show me the current balance sheet" },
  { label: "Income Statement", icon: "&#128200;", template: "Show me the income statement" },
  { label: "Trial Balance", icon: "&#9878;", template: "Show me the trial balance" },
];

function renderActionButtons() {
  var wrap = document.getElementById("examplePrompts");
  if (!wrap) return;
  var html = "";
  actionTemplates.forEach(function(a) {
    html += '<button class="action-pill" onclick="handleAction(\'' + escHtml(a.template) + '\')">' +
      '<span class="icon">' + a.icon + '</span>' + a.label + '</button>';
  });
  wrap.innerHTML = html;
  var parent = document.getElementById("examplePromptsWrap");
  if (parent) parent.style.display = "";
}

function handleAction(template) {
  if (template.includes("$")) {
    // Expense/revenue actions: focus input with template
    chatInput.value = template;
    chatInput.focus();
  } else {
    // Report actions: send immediately
    chatInput.value = template;
    chatForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
}

// ── Feature 4: Transaction History Tab ─────────────────────
var txTabLoaded = false;

async function loadTransactions() {
  var view = document.getElementById("transactionView");
  if (!view) return;
  view.innerHTML = '<div class="flex items-center gap-2 text-xs text-gray-600 py-4">' +
    '<span class="typing-dot inline-block w-1.5 h-1.5 bg-gray-500 rounded-full"></span>' +
    '<span class="ml-1">Loading transactions...</span></div>';
  try {
    var res = await apiFetch("/api/transactions?limit=50");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    var txs = data.transactions || [];
    if (txs.length === 0) {
      view.innerHTML = '<div class="text-center py-12 text-gray-600">' +
        '<div class="empty-state-icon mb-3">&#128203;</div>' +
        '<p class="font-medium">No transactions yet</p>' +
        '<p class="text-xs mt-1 text-gray-700 mb-4">Transactions are created when you approve a proposal</p>' +
        '<button onclick="handleAction(\'Record a $ expense for \')" class="btn-ghost text-xs px-4 py-2 rounded-lg">Record your first transaction</button>' +
        '</div>';
      return;
    }
    var html = '<div class="tx-header"><span>Date</span><span>Description</span><span>Account</span><span style="text-align:right">Debit</span><span style="text-align:right">Credit</span></div>';
    txs.forEach(function(tx) {
      var debit = tx.debit && tx.debit !== "0" ? tx.debit : "";
      var credit = tx.credit && tx.credit !== "0" ? tx.credit : "";
      html += '<div class="tx-row">' +
        '<span class="tx-date">' + escHtml(tx.date || "") + '</span>' +
        '<span class="tx-desc">' + escHtml(tx.description || tx.user_message || "") + '</span>' +
        '<span class="tx-acct">' + escHtml(tx.account || "") + '</span>' +
        '<span class="tx-debit">' + (debit ? "$" + escHtml(debit) : "") + '</span>' +
        '<span class="tx-credit">' + (credit ? "$" + escHtml(credit) : "") + '</span>' +
      '</div>';
    });
    view.innerHTML = html;
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: #ef4444;">Failed to load transactions.</p>';
  }
}

// ── Interactive Report Rendering ─────────────────────────────
async function showInteractiveReport(reportType, btn) {
  btn.disabled = true;
  btn.textContent = "Loading...";
  try {
    var res = await apiFetch("/api/reports/" + reportType + "/csv");
    var text = await res.text();
    var lines = text.trim().split("\n");
    if (lines.length < 2) { btn.textContent = "No data"; return; }
    var headers = lines[0].split(",");
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cells = lines[i].split(",");
      rows.push(cells);
    }

    // Detect numeric columns
    var numCols = headers.map(function(h) { return /amount|debit|credit|total|balance|net/i.test(h); });

    function fmtNum(v) {
      if (!v || !v.trim()) return "";
      var n = parseFloat(v.replace(/[$,]/g, ""));
      if (isNaN(n)) return escHtml(v);
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    var sortCol = -1, sortAsc = true;

    function renderTable() {
      var sorted = rows.slice();
      if (sortCol >= 0) {
        sorted.sort(function(a, b) {
          var va = numCols[sortCol] ? parseFloat((a[sortCol] || "0").replace(/[$,]/g, "")) : (a[sortCol] || "").toLowerCase();
          var vb = numCols[sortCol] ? parseFloat((b[sortCol] || "0").replace(/[$,]/g, "")) : (b[sortCol] || "").toLowerCase();
          if (va < vb) return sortAsc ? -1 : 1;
          if (va > vb) return sortAsc ? 1 : -1;
          return 0;
        });
      }
      var html = '<table class="w-full text-xs border-collapse report-table"><thead><tr>';
      headers.forEach(function(h, i) {
        var cls = numCols[i] ? "text-right px-2 py-1 border-b font-medium" : "text-left px-2 py-1 border-b font-medium";
        var arrow = sortCol === i ? (sortAsc ? " &#9650;" : " &#9660;") : "";
        html += '<th class="' + cls + '" style="cursor:pointer; color: var(--text-muted);" onclick="sortReport(' + i + ')">' + escHtml(h) + arrow + '</th>';
      });
      html += '</tr></thead><tbody>';
      var isTotals = /^(total|net|grand)/i;
      sorted.forEach(function(row) {
        var rowClass = isTotals.test(row[0] || row[1] || "") ? "report-totals" : "";
        html += '<tr class="' + rowClass + '">';
        row.forEach(function(cell, i) {
          if (numCols[i]) {
            html += '<td class="text-right px-2 py-1 border-b font-mono" style="font-variant-numeric: tabular-nums;">' + fmtNum(cell) + '</td>';
          } else {
            html += '<td class="text-left px-2 py-1 border-b">' + escHtml((cell || "").trim()) + '</td>';
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table>';
      document.getElementById("reportTableContainer").innerHTML = html;
    }

    window.sortReport = function(col) {
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = true; }
      renderTable();
    };

    // Replace the button with the interactive table
    var container = document.createElement("div");
    container.className = "fade-up flex gap-3";
    container.innerHTML =
      '<div class="w-7 h-7 shrink-0"></div>' +
      '<div class="flex-1">' +
        '<div class="flex items-center justify-between mb-2">' +
          '<span class="text-xs font-medium" style="color: var(--text-muted);">' + escHtml(headers.join(", ")) + '</span>' +
          '<div class="flex gap-1">' +
            '<a href="/api/reports/' + reportType + '/csv" class="text-xs px-2 py-1 rounded" style="color: var(--primary);" download>CSV</a>' +
            '<a href="/api/reports/' + reportType + '/xlsx" class="text-xs px-2 py-1 rounded" style="color: var(--primary);" download>XLSX</a>' +
          '</div>' +
        '</div>' +
        '<div id="reportTableContainer" class="overflow-x-auto rounded-lg border" style="border-color: var(--border);"></div>' +
      '</div>';
    btn.closest(".flex.gap-3").replaceWith(container);
    renderTable();
  } catch (err) {
    btn.textContent = "Failed to load";
  }
}

// ── Feature 2: Export Reports as CSV ───────────────────────
function downloadReportCSV(reportType) {
  window.open("/api/reports/" + reportType + "/csv", "_blank");
}

// ── Dashboard ───────────────────────────────────────────────
async function loadDashboard() {
  var view = document.getElementById("dashboardView");
  view.innerHTML = '<div class="text-xs py-4" style="color: var(--text-muted);">Loading dashboard...</div>';
  try {
    var res = await apiFetch("/api/dashboard");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var d = await res.json();

    // Account cards with transfer button
    var accountsHtml = (d.accounts || []).map(function(a) {
      var color = a.balance >= 0 ? "var(--success)" : "var(--danger)";
      return '<div class="dash-card">' +
        '<p class="text-xs" style="color: var(--text-muted);">' + escHtml(a.name) + '</p>' +
        '<p class="text-lg font-bold font-mono mt-1" style="color: ' + color + ';">$' + Math.abs(a.balance).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p>' +
        '<p class="text-xs mt-0.5" style="color: var(--text-muted);">' + escHtml(a.type) + '</p>' +
      '</div>';
    }).join("");
    if (d.accounts && d.accounts.length >= 2) {
      accountsHtml += '<div class="dash-card flex items-center justify-center cursor-pointer" onclick="showTransferModal()" style="border-style: dashed;">' +
        '<p class="text-sm font-medium" style="color: var(--primary);">🔄 Transfer</p></div>';
    }

    // Summary + donut chart
    var s = d.summary || {};
    var netColor = (s.net || 0) >= 0 ? "var(--success)" : "var(--danger)";
    var donutHtml = renderDonutChart(s.total_income || 0, s.total_expenses || 0);

    // Monthly trend line chart
    var trendHtml = renderLineChart(d.monthly_trend || []);

    // Category chart
    var cats = d.by_category || [];
    var maxAmt = cats.length > 0 ? cats[0].total : 1;
    var catHtml = cats.map(function(c) {
      var pct = (c.total / maxAmt) * 100;
      return '<div class="flex items-center gap-2 text-xs mb-2">' +
        '<span class="w-24 truncate" style="color: var(--text-secondary);">' + escHtml(c.icon || "") + ' ' + escHtml(c.name || "Uncategorized") + '</span>' +
        '<div class="flex-1 h-4 rounded" style="background: var(--surface);">' +
          '<div class="h-4 rounded" style="width: ' + pct + '%; background: var(--primary);"></div>' +
        '</div>' +
        '<span class="w-16 text-right font-mono" style="color: var(--text-secondary);">$' + c.total.toLocaleString(undefined, {minimumFractionDigits: 0}) + '</span>' +
        '<span class="w-10 text-right" style="color: var(--text-muted);">' + (c.pct || 0) + '%</span>' +
      '</div>';
    }).join("");

    // Budget progress
    var budgets = d.budgets || [];
    var budgetHtml = budgets.map(function(b) {
      var pct = b.pct || 0;
      var barColor = pct > 100 ? "var(--danger)" : pct > 80 ? "var(--warning)" : "var(--success)";
      return '<div class="flex items-center gap-2 text-xs mb-2">' +
        '<span class="w-20 truncate" style="color: var(--text-secondary);">' + escHtml(b.category_icon || "") + ' ' + escHtml(b.category_name || "") + '</span>' +
        '<div class="flex-1 h-2 rounded" style="background: var(--surface);">' +
          '<div class="h-2 rounded" style="width: ' + Math.min(pct, 100) + '%; background: ' + barColor + ';"></div>' +
        '</div>' +
        '<span class="w-12 text-right font-mono" style="color: ' + barColor + ';">' + pct + '%</span>' +
      '</div>';
    }).join("");

    // Recent transactions
    var txHtml = (d.recent_transactions || []).map(function(tx) {
      var sign = tx.amount < 0 ? "-" : "+";
      var color = tx.amount < 0 ? "var(--danger)" : "var(--success)";
      return '<div class="flex items-center gap-3 text-xs py-2" style="border-bottom: 1px solid var(--border-subtle);">' +
        '<span style="color: var(--text-muted); min-width: 70px;">' + escHtml(tx.date || "") + '</span>' +
        '<span class="flex-1 truncate" style="color: var(--text-secondary);">' + escHtml(tx.description || tx.category_name || "") + '</span>' +
        '<span class="text-xs px-1.5 py-0.5 rounded" style="background: var(--surface); color: var(--text-muted);">' + escHtml(tx.category_icon || "") + ' ' + escHtml(tx.category_name || "—") + '</span>' +
        '<span class="font-mono font-medium" style="color: ' + color + ';">' + sign + '$' + Math.abs(tx.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</span>' +
      '</div>';
    }).join("");

    view.innerHTML =
      '<div class="fade-up">' +
        // Account cards + transfer
        '<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">' + accountsHtml + '</div>' +
        // Summary row: donut + income/expenses + trend
        '<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">' +
          '<div class="dash-card flex flex-col items-center">' +
            '<p class="text-xs font-medium mb-2" style="color: var(--text-muted);">' + escHtml(s.period || "This Month") + '</p>' +
            donutHtml +
            '<div class="flex gap-4 mt-2 text-xs">' +
              '<span style="color: var(--success);">● Income</span>' +
              '<span style="color: var(--danger);">● Expenses</span>' +
            '</div>' +
          '</div>' +
          '<div class="dash-card">' +
            '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Income vs Expenses</p>' +
            '<div class="space-y-2">' +
              '<div><p class="text-xs" style="color: var(--text-muted);">Income</p><p class="text-lg font-bold font-mono" style="color: var(--success);">$' + (s.total_income || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
              '<div><p class="text-xs" style="color: var(--text-muted);">Expenses</p><p class="text-lg font-bold font-mono" style="color: var(--danger);">$' + (s.total_expenses || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
              '<div><p class="text-xs" style="color: var(--text-muted);">Net</p><p class="text-lg font-bold font-mono" style="color: ' + netColor + ';">$' + (s.net || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
            '</div>' +
          '</div>' +
          '<div class="dash-card">' +
            '<p class="text-xs font-medium mb-2" style="color: var(--text-muted);">6-Month Trend</p>' +
            trendHtml +
            '<div class="flex gap-3 mt-1 text-xs">' +
              '<span style="color: var(--success);">● Income</span>' +
              '<span style="color: var(--danger);">● Expenses</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Category + Budget row
        '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">' +
          '<div class="dash-card">' +
            '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Spending by Category</p>' +
            (catHtml || '<p class="text-xs" style="color: var(--text-muted);">No expenses this month</p>') +
          '</div>' +
          '<div class="dash-card">' +
            '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Budget Progress</p>' +
            (budgetHtml || '<p class="text-xs" style="color: var(--text-muted);">No budgets set. Go to Budgets tab to create one.</p>') +
          '</div>' +
        '</div>' +
        // Recent transactions
        '<div class="dash-card">' +
          '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Recent Transactions</p>' +
          (txHtml || '<p class="text-xs" style="color: var(--text-muted);">No transactions yet</p>') +
        '</div>' +
      '</div>';
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: var(--danger);">Failed to load dashboard.</p>';
  }
}

// ── Accounts Tab ────────────────────────────────────────────
async function loadAccounts() {
  var view = document.getElementById("accountsView");
  view.innerHTML = '<div class="flex items-center gap-2 text-xs py-4" style="color: var(--text-muted);"><span>Loading...</span></div>';
  try {
    var res = await apiFetch("/api/accounts");
    var data = await res.json();
    var accounts = data.accounts || [];

    var html = '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-sm font-medium" style="color: var(--text-primary);">Accounts</h3>' +
      '<button onclick="showAddAccountModal()" class="btn-primary text-xs px-3 py-1.5 rounded-lg">+ Add Account</button>' +
    '</div>';

    if (accounts.length === 0) {
      html += '<p class="text-xs" style="color: var(--text-muted);">No accounts yet.</p>';
    } else {
      accounts.forEach(function(a) {
        var bal = a.balance || 0;
        var color = bal >= 0 ? "var(--success)" : "var(--danger)";
        html += '<div class="dash-card flex items-center justify-between mb-3">' +
          '<div>' +
            '<p class="text-sm font-medium" style="color: var(--text-primary);">' + escHtml(a.name) + '</p>' +
            '<p class="text-xs" style="color: var(--text-muted);">' + escHtml(a.type) + ' &middot; ' + escHtml(a.currency) + '</p>' +
          '</div>' +
          '<div class="text-right">' +
            '<p class="text-sm font-bold font-mono" style="color: ' + color + ';">$' + Math.abs(bal).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p>' +
            '<button onclick="deleteAccount(' + a.id + ')" class="text-xs mt-1" style="color: var(--danger);">Remove</button>' +
          '</div>' +
        '</div>';
      });
    }
    view.innerHTML = html;
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: var(--danger);">Failed to load accounts.</p>';
  }
}

function showAddAccountModal() {
  var existing = document.getElementById("addAccountModal");
  if (existing) existing.remove();
  var modal = document.createElement("div");
  modal.id = "addAccountModal";
  modal.className = "modal-overlay";
  modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
  modal.innerHTML =
    '<div class="modal-content">' +
      '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Add Account</h3>' +
      '<input id="accName" type="text" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-3" ' +
        'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" ' +
        'placeholder="Account name (e.g. Main Checking)" />' +
      '<select id="accType" class="w-full rounded-lg px-3 py-2 text-sm mb-3" ' +
        'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' +
        '<option value="checking">Checking</option><option value="savings">Savings</option>' +
        '<option value="credit">Credit Card</option><option value="cash">Cash</option>' +
        '<option value="investment">Investment</option></select>' +
      '<div class="flex gap-2">' +
        '<button onclick="submitAddAccount()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Add</button>' +
        '<button onclick="document.getElementById(\'addAccountModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);
}

async function submitAddAccount() {
  var name = document.getElementById("accName").value.trim();
  var type = document.getElementById("accType").value;
  if (!name) { showToast("Please enter a name", "error"); return; }
  document.getElementById("addAccountModal").remove();
  try {
    var res = await apiFetch("/api/accounts?name=" + encodeURIComponent(name) + "&acc_type=" + type, { method: "POST" });
    if (res.ok) { showToast("Account created", "success"); loadAccounts(); loadDashboard(); }
    else showToast("Failed to create account", "error");
  } catch (e) { showToast("Failed to create account", "error"); }
}

async function deleteAccount(id) {
  if (!confirm("Remove this account?")) return;
  var res = await apiFetch("/api/accounts/" + id, { method: "DELETE" });
  if (res.ok) { showToast("Account removed", "success"); loadAccounts(); loadDashboard(); }
}

// ── Categories Tab ──────────────────────────────────────────
async function loadCategories() {
  var view = document.getElementById("categoriesView");
  view.innerHTML = '<div class="flex items-center gap-2 text-xs py-4" style="color: var(--text-muted);"><span>Loading...</span></div>';
  try {
    var res = await apiFetch("/api/categories");
    var data = await res.json();
    var cats = data.categories || [];

    var html = '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-sm font-medium" style="color: var(--text-primary);">Categories</h3>' +
      '<button onclick="showAddCategoryModal()" class="btn-primary text-xs px-3 py-1.5 rounded-lg">+ Add Category</button>' +
    '</div>';

    if (cats.length === 0) {
      html += '<p class="text-xs" style="color: var(--text-muted);">No categories yet.</p>';
    } else {
      html += '<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">';
      cats.forEach(function(c) {
        html += '<div class="dash-card flex items-center gap-2">' +
          '<span class="text-lg">' + escHtml(c.icon || "📁") + '</span>' +
          '<span class="text-xs font-medium" style="color: var(--text-secondary);">' + escHtml(c.name) + '</span>' +
        '</div>';
      });
      html += '</div>';
    }
    view.innerHTML = html;
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: var(--danger);">Failed to load categories.</p>';
  }
}

function showAddCategoryModal() {
  var existing = document.getElementById("addCategoryModal");
  if (existing) existing.remove();
  var modal = document.createElement("div");
  modal.id = "addCategoryModal";
  modal.className = "modal-overlay";
  modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
  modal.innerHTML =
    '<div class="modal-content">' +
      '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Add Category</h3>' +
      '<input id="catName" type="text" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-3" ' +
        'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" ' +
        'placeholder="Category name (e.g. Groceries)" />' +
      '<input id="catIcon" type="text" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-3" ' +
        'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" ' +
        'placeholder="Emoji icon (optional)" />' +
      '<div class="flex gap-2">' +
        '<button onclick="submitAddCategory()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Add</button>' +
        '<button onclick="document.getElementById(\'addCategoryModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);
}

async function submitAddCategory() {
  var name = document.getElementById("catName").value.trim();
  var icon = document.getElementById("catIcon").value.trim();
  if (!name) { showToast("Please enter a name", "error"); return; }
  document.getElementById("addCategoryModal").remove();
  try {
    var res = await apiFetch("/api/categories?name=" + encodeURIComponent(name) + "&icon=" + encodeURIComponent(icon), { method: "POST" });
    if (res.ok) { showToast("Category created", "success"); loadCategories(); }
    else showToast("Failed to create category", "error");
  } catch (e) { showToast("Failed to create category", "error"); }
}

// ── Recurring Transactions Tab ──────────────────────────────
async function loadRecurring() {
  var view = document.getElementById("recurringView");
  view.innerHTML = '<div class="text-xs py-4" style="color: var(--text-muted);">Loading...</div>';
  try {
    var res = await apiFetch("/api/recurring");
    var data = await res.json();
    var items = data.recurring || [];

    var html = '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-sm font-medium" style="color: var(--text-primary);">Recurring Transactions</h3>' +
      '<button onclick="showAddRecurringModal()" class="btn-primary text-xs px-3 py-1.5 rounded-lg">+ Add</button>' +
    '</div>';

    if (items.length === 0) {
      html += '<p class="text-xs" style="color: var(--text-muted);">No recurring transactions. Add your rent, salary, subscriptions here.</p>';
    } else {
      items.forEach(function(r) {
        var sign = r.type === "income" ? "+" : "-";
        var color = r.type === "income" ? "var(--success)" : "var(--danger)";
        var status = r.is_active ? "" : '<span class="text-xs ml-2" style="color: var(--text-muted);">(paused)</span>';
        html += '<div class="dash-card flex items-center justify-between mb-3">' +
          '<div>' +
            '<p class="text-sm font-medium" style="color: var(--text-primary);">' + escHtml(r.description) + status + '</p>' +
            '<p class="text-xs" style="color: var(--text-muted);">' + escHtml(r.frequency) + ' &middot; next: ' + escHtml(r.next_date) + ' &middot; ' + escHtml(r.account_name || "") + '</p>' +
          '</div>' +
          '<div class="text-right flex items-center gap-2">' +
            '<span class="font-mono font-medium" style="color: ' + color + ';">' + sign + '$' + Math.abs(r.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</span>' +
            '<button onclick="executeRecurring(' + r.id + ')" class="text-xs px-2 py-1 rounded" style="color: var(--primary);" title="Execute now">▶</button>' +
            '<button onclick="deleteRecurring(' + r.id + ')" class="text-xs px-2 py-1 rounded" style="color: var(--danger);" title="Pause">⏸</button>' +
          '</div>' +
        '</div>';
      });
    }
    view.innerHTML = html;
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: var(--danger);">Failed to load recurring transactions.</p>';
  }
}

function showAddRecurringModal() {
  var existing = document.getElementById("addRecurringModal");
  if (existing) existing.remove();
  // Load accounts for dropdown
  apiFetch("/api/accounts").then(function(res) { return res.json(); }).then(function(data) {
    var accounts = data.accounts || [];
    var accOpts = accounts.map(function(a) { return '<option value="' + a.id + '">' + escHtml(a.name) + '</option>'; }).join("");
    return apiFetch("/api/categories");
  }).then(function(res) { return res.json(); }).then(function(data) {
    var cats = data.categories || [];
    var catOpts = cats.map(function(c) { return '<option value="' + c.id + '">' + escHtml(c.icon || "") + ' ' + escHtml(c.name) + '</option>'; }).join("");

    var modal = document.createElement("div");
    modal.id = "addRecurringModal";
    modal.className = "modal-overlay";
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML =
      '<div class="modal-content">' +
        '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Add Recurring Transaction</h3>' +
        '<input id="recDesc" type="text" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-2" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" placeholder="Description (e.g. Monthly rent)" />' +
        '<div class="flex gap-2 mb-2">' +
          '<input id="recAmount" type="number" step="0.01" class="input-glow flex-1 rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" placeholder="Amount" />' +
          '<select id="recType" class="rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);"><option value="expense">Expense</option><option value="income">Income</option></select>' +
        '</div>' +
        '<select id="recAccount" class="w-full rounded-lg px-3 py-2 text-sm mb-2" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + accOpts + '</select>' +
        '<select id="recCategory" class="w-full rounded-lg px-3 py-2 text-sm mb-2" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);"><option value="">No category</option>' + catOpts + '</select>' +
        '<div class="flex gap-2 mb-3">' +
          '<select id="recFreq" class="flex-1 rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' +
            '<option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select>' +
          '<input id="recNextDate" type="date" class="flex-1 rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" />' +
        '</div>' +
        '<div class="flex gap-2">' +
          '<button onclick="submitAddRecurring()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Add</button>' +
          '<button onclick="document.getElementById(\'addRecurringModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
  });
}

async function submitAddRecurring() {
  var desc = document.getElementById("recDesc").value.trim();
  var amount = parseFloat(document.getElementById("recAmount").value);
  var txType = document.getElementById("recType").value;
  var accountId = parseInt(document.getElementById("recAccount").value);
  var categoryId = parseInt(document.getElementById("recCategory").value) || null;
  var freq = document.getElementById("recFreq").value;
  var nextDate = document.getElementById("recNextDate").value;
  if (!desc || !amount || !nextDate) { showToast("Fill in all required fields", "error"); return; }
  document.getElementById("addRecurringModal").remove();
  var params = "account_id=" + accountId + "&description=" + encodeURIComponent(desc) + "&amount=" + amount + "&tx_type=" + txType + "&frequency=" + freq + "&next_date=" + nextDate;
  if (categoryId) params += "&category_id=" + categoryId;
  var res = await apiFetch("/api/recurring?" + params, { method: "POST" });
  if (res.ok) { showToast("Recurring transaction added", "success"); loadRecurring(); }
  else showToast("Failed to add", "error");
}

async function executeRecurring(id) {
  var res = await apiFetch("/api/recurring/" + id + "/execute", { method: "POST" });
  if (res.ok) { showToast("Executed", "success"); loadRecurring(); }
  else showToast("Failed to execute", "error");
}

async function deleteRecurring(id) {
  if (!confirm("Pause this recurring transaction?")) return;
  var res = await apiFetch("/api/recurring/" + id, { method: "DELETE" });
  if (res.ok) { showToast("Paused", "success"); loadRecurring(); }
}

// ── Budgets Tab ─────────────────────────────────────────────
async function loadBudgets() {
  var view = document.getElementById("budgetsView");
  view.innerHTML = '<div class="text-xs py-4" style="color: var(--text-muted);">Loading...</div>';
  try {
    var now = new Date();
    var res = await apiFetch("/api/budgets?year=" + now.getFullYear() + "&month=" + (now.getMonth() + 1));
    var data = await res.json();
    var budgets = data.budgets || [];

    var html = '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-sm font-medium" style="color: var(--text-primary);">Budgets — ' + now.toLocaleString(undefined, {month: "long", year: "numeric"}) + '</h3>' +
      '<button onclick="showAddBudgetModal()" class="btn-primary text-xs px-3 py-1.5 rounded-lg">+ Set Budget</button>' +
    '</div>';

    if (budgets.length === 0) {
      html += '<p class="text-xs" style="color: var(--text-muted);">No budgets set. Create budgets to track spending limits per category.</p>';
    } else {
      budgets.forEach(function(b) {
        var pct = b.pct || 0;
        var barColor = pct > 100 ? "var(--danger)" : pct > 80 ? "var(--warning)" : "var(--success)";
        html += '<div class="dash-card mb-3">' +
          '<div class="flex items-center justify-between mb-2">' +
            '<span class="text-sm font-medium" style="color: var(--text-primary);">' + escHtml(b.category_icon || "") + ' ' + escHtml(b.category_name || "Unknown") + '</span>' +
            '<span class="text-xs font-mono" style="color: var(--text-secondary);">$' + (b.spent || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + ' / $' + (b.budget_amount || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</span>' +
          '</div>' +
          '<div class="w-full h-2 rounded" style="background: var(--surface);">' +
            '<div class="h-2 rounded" style="width: ' + Math.min(pct, 100) + '%; background: ' + barColor + ';"></div>' +
          '</div>' +
          '<div class="flex justify-between mt-1">' +
            '<span class="text-xs" style="color: ' + barColor + ';">' + pct + '% used</span>' +
            '<button onclick="deleteBudget(' + b.id + ')" class="text-xs" style="color: var(--danger);">Remove</button>' +
          '</div>' +
        '</div>';
      });
    }
    view.innerHTML = html;
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: var(--danger);">Failed to load budgets.</p>';
  }
}

function showAddBudgetModal() {
  apiFetch("/api/categories").then(function(res) { return res.json(); }).then(function(data) {
    var cats = data.categories || [];
    var catOpts = cats.map(function(c) { return '<option value="' + c.id + '">' + escHtml(c.icon || "") + ' ' + escHtml(c.name) + '</option>'; }).join("");
    var modal = document.createElement("div");
    modal.id = "addBudgetModal";
    modal.className = "modal-overlay";
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML =
      '<div class="modal-content">' +
        '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Set Monthly Budget</h3>' +
        '<select id="budgetCategory" class="w-full rounded-lg px-3 py-2 text-sm mb-3" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + catOpts + '</select>' +
        '<input id="budgetAmount" type="number" step="0.01" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-3" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" placeholder="Monthly limit amount" />' +
        '<div class="flex gap-2">' +
          '<button onclick="submitAddBudget()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Set Budget</button>' +
          '<button onclick="document.getElementById(\'addBudgetModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
  });
}

async function submitAddBudget() {
  var categoryId = parseInt(document.getElementById("budgetCategory").value);
  var amount = parseFloat(document.getElementById("budgetAmount").value);
  if (!amount || amount <= 0) { showToast("Enter a valid amount", "error"); return; }
  document.getElementById("addBudgetModal").remove();
  var res = await apiFetch("/api/budgets?category_id=" + categoryId + "&amount=" + amount, { method: "POST" });
  if (res.ok) { showToast("Budget set", "success"); loadBudgets(); }
  else showToast("Failed to set budget", "error");
}

async function deleteBudget(id) {
  if (!confirm("Remove this budget?")) return;
  var res = await apiFetch("/api/budgets/" + id, { method: "DELETE" });
  if (res.ok) { showToast("Budget removed", "success"); loadBudgets(); }
}

// ── Transfer Modal ──────────────────────────────────────────
function showTransferModal() {
  apiFetch("/api/accounts").then(function(res) { return res.json(); }).then(function(data) {
    var accounts = data.accounts || [];
    var accOpts = accounts.map(function(a) { return '<option value="' + a.id + '">' + escHtml(a.name) + ' ($' + (a.balance || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + ')</option>'; }).join("");
    var modal = document.createElement("div");
    modal.id = "transferModal";
    modal.className = "modal-overlay";
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML =
      '<div class="modal-content">' +
        '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Transfer Between Accounts</h3>' +
        '<label class="text-xs mb-1 block" style="color: var(--text-muted);">From</label>' +
        '<select id="transferFrom" class="w-full rounded-lg px-3 py-2 text-sm mb-2" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + accOpts + '</select>' +
        '<label class="text-xs mb-1 block" style="color: var(--text-muted);">To</label>' +
        '<select id="transferTo" class="w-full rounded-lg px-3 py-2 text-sm mb-2" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + accOpts + '</select>' +
        '<input id="transferAmount" type="number" step="0.01" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-2" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" placeholder="Amount" />' +
        '<input id="transferDesc" type="text" class="input-glow w-full rounded-lg px-3 py-2 text-sm mb-3" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);" placeholder="Description (e.g. Transfer to savings)" />' +
        '<div class="flex gap-2">' +
          '<button onclick="submitTransfer()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Transfer</button>' +
          '<button onclick="document.getElementById(\'transferModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
  });
}

async function submitTransfer() {
  var from = parseInt(document.getElementById("transferFrom").value);
  var to = parseInt(document.getElementById("transferTo").value);
  var amount = parseFloat(document.getElementById("transferAmount").value);
  var desc = document.getElementById("transferDesc").value.trim() || "Transfer";
  if (from === to) { showToast("Cannot transfer to the same account", "error"); return; }
  if (!amount || amount <= 0) { showToast("Enter a valid amount", "error"); return; }
  document.getElementById("transferModal").remove();
  var res = await apiFetch("/api/transfers?from_account_id=" + from + "&to_account_id=" + to + "&amount=" + amount + "&description=" + encodeURIComponent(desc), { method: "POST" });
  if (res.ok) { showToast("Transfer completed", "success"); loadDashboard(); loadAccounts(); }
  else showToast("Transfer failed", "error");
}

// ── Charts ──────────────────────────────────────────────────
function renderDonutChart(income, expenses) {
  var total = income + expenses;
  if (total === 0) return '<p class="text-xs" style="color: var(--text-muted);">No data</p>';
  var incPct = (income / total) * 100;
  var expPct = (expenses / total) * 100;
  var r = 40, cx = 50, cy = 50;
  function arc(pct, color) {
    if (pct <= 0) return "";
    var angle = (pct / 100) * 360;
    var startRad = (-90) * Math.PI / 180;
    var endRad = (-90 + angle) * Math.PI / 180;
    var x1 = cx + r * Math.cos(startRad), y1 = cy + r * Math.sin(startRad);
    var x2 = cx + r * Math.cos(endRad), y2 = cy + r * Math.sin(endRad);
    var large = angle > 180 ? 1 : 0;
    return '<path d="M' + cx + ',' + cy + ' L' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + large + ',1 ' + x2 + ',' + y2 + ' Z" fill="' + color + '" />';
  }
  return '<svg viewBox="0 0 100 100" class="w-24 h-24">' +
    arc(expPct, "#e11d48") + arc(incPct, "#16a34a") +
    '<circle cx="' + cx + '" cy="' + cy + '" r="25" fill="white" />' +
    '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" font-size="6" fill="#334155" font-weight="bold">$' + (total).toLocaleString(undefined, {maximumFractionDigits: 0}) + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" font-size="4" fill="#94a3b8">total</text>' +
  '</svg>';
}

function renderLineChart(trend) {
  if (!trend || trend.length === 0) return '<p class="text-xs" style="color: var(--text-muted);">No trend data</p>';
  var maxVal = 0;
  trend.forEach(function(t) { maxVal = Math.max(maxVal, t.income, t.expenses); });
  if (maxVal === 0) maxVal = 1;
  var w = 200, h = 60, pad = 10;
  var stepX = (w - pad * 2) / (trend.length - 1 || 1);

  function pts(key) {
    return trend.map(function(t, i) {
      var x = pad + i * stepX;
      var y = h - pad - ((t[key] / maxVal) * (h - pad * 2));
      return x + "," + y;
    }).join(" ");
  }

  var labels = trend.map(function(t, i) {
    var x = pad + i * stepX;
    return '<text x="' + x + '" y="' + (h - 1) + '" text-anchor="middle" font-size="4" fill="#94a3b8">' + t.label + '</text>';
  }).join("");

  return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="w-full h-16">' +
    '<polyline points="' + pts("income") + '" fill="none" stroke="#16a34a" stroke-width="1.5" />' +
    '<polyline points="' + pts("expenses") + '" fill="none" stroke="#e11d48" stroke-width="1.5" />' +
    labels +
  '</svg>';
}

// ── Tax Tab ─────────────────────────────────────────────────
async function loadTax() {
  var view = document.getElementById("taxView");
  view.innerHTML = '<div class="text-xs py-4" style="color: var(--text-muted);">Loading...</div>';
  try {
    var now = new Date();
    var year = now.getFullYear();
    var res = await apiFetch("/api/tax/summary?year=" + year);
    var s = await res.json();

    var tagColors = { "deductible": "var(--success)", "personal": "var(--text-muted)", "business": "#3b82f6", "non-deductible": "var(--danger)", "capital_gains": "#8b5cf6" };
    var tagLabels = { "deductible": "Deductible", "personal": "Personal", "business": "Business", "non-deductible": "Non-deductible", "capital_gains": "Capital Gains" };

    // Tag breakdown cards
    var tagCards = Object.entries(s.by_tag || {}).map(function(entry) {
      var tag = entry[0], info = entry[1];
      return '<div class="dash-card">' +
        '<p class="text-xs" style="color: ' + (tagColors[tag] || "var(--text-muted)") + ';">' + (tagLabels[tag] || tag) + '</p>' +
        '<p class="text-lg font-bold font-mono mt-1">$' + info.total.toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p>' +
        '<p class="text-xs" style="color: var(--text-muted);">' + info.count + ' transactions</p>' +
      '</div>';
    }).join("");

    // Summary
    var html = '<div class="fade-up">' +
      '<div class="flex items-center justify-between mb-4">' +
        '<h3 class="text-sm font-medium" style="color: var(--text-primary);">Tax Report — ' + year + '</h3>' +
        '<div class="flex gap-2">' +
          '<button onclick="autoTagTransactions()" class="btn-ghost text-xs px-3 py-1.5 rounded-lg">Auto-tag</button>' +
          '<a href="/api/tax/export?year=' + year + '" class="btn-ghost text-xs px-3 py-1.5 rounded-lg" style="color: var(--primary);">Export CSV</a>' +
        '</div>' +
      '</div>' +
      // Summary cards
      '<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">' +
        '<div class="dash-card"><p class="text-xs" style="color: var(--text-muted);">Total Income</p><p class="text-lg font-bold font-mono" style="color: var(--success);">$' + (s.total_income || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
        '<div class="dash-card"><p class="text-xs" style="color: var(--text-muted);">Total Deductions</p><p class="text-lg font-bold font-mono" style="color: var(--success);">$' + (s.total_deductible || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
        '<div class="dash-card"><p class="text-xs" style="color: var(--text-muted);">Business Expenses</p><p class="text-lg font-bold font-mono" style="color: #3b82f6;">$' + (s.total_business || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
        '<div class="dash-card"><p class="text-xs" style="color: var(--text-muted);">Taxable Income</p><p class="text-lg font-bold font-mono" style="color: var(--danger);">$' + (s.taxable_income || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
      '</div>' +
      // Tag breakdown
      '<div class="mb-6">' +
        '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Breakdown by Tax Tag</p>' +
        (tagCards || '<p class="text-xs" style="color: var(--text-muted);">No tagged transactions. Click Auto-tag to categorize by default rules.</p>') +
      '</div>' +
      // Tagged transactions list
      '<div id="taxTxList" class="text-xs" style="color: var(--text-muted);">Loading transactions...</div>' +
    '</div>';

    view.innerHTML = html;
    loadTaxTransactions(year);
  } catch (err) {
    view.innerHTML = '<p class="text-sm" style="color: var(--danger);">Failed to load tax report.</p>';
  }
}

async function loadTaxTransactions(year) {
  var list = document.getElementById("taxTxList");
  if (!list) return;
  try {
    var res = await apiFetch("/api/tax/transactions?year=" + year);
    var data = await res.json();
    var txs = data.transactions || [];
    var tagColors = { "deductible": "var(--success)", "personal": "var(--text-muted)", "business": "#3b82f6", "non-deductible": "var(--danger)", "capital_gains": "#8b5cf6" };

    if (txs.length === 0) {
      list.innerHTML = '<p>No transactions found for ' + year + '.</p>';
      return;
    }

    var html = '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Tagged Transactions (' + txs.length + ')</p>';
    txs.forEach(function(tx) {
      var tag = tx.tag || "untagged";
      var color = tagColors[tag] || "var(--text-muted)";
      var sign = tx.amount < 0 ? "-" : "+";
      var amtColor = tx.amount < 0 ? "var(--danger)" : "var(--success)";
      html += '<div class="flex items-center gap-3 py-2" style="border-bottom: 1px solid var(--border-subtle);">' +
        '<span style="color: var(--text-muted); min-width: 70px;">' + escHtml(tx.date || "") + '</span>' +
        '<span class="flex-1 truncate" style="color: var(--text-secondary);">' + escHtml(tx.description || "") + '</span>' +
        '<span class="text-xs px-1.5 py-0.5 rounded cursor-pointer" style="background: ' + color + '20; color: ' + color + ';" onclick="retagTransaction(' + tx.id + ', \'' + year + '\')">' + escHtml(tag) + '</span>' +
        '<span class="font-mono font-medium" style="color: ' + amtColor + ';">' + sign + '$' + Math.abs(tx.amount).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</span>' +
      '</div>';
    });
    list.innerHTML = html;
  } catch (err) {
    list.innerHTML = '<p style="color: var(--danger);">Failed to load transactions.</p>';
  }
}

async function retagTransaction(txId, year) {
  var tags = ["deductible", "personal", "business", "non-deductible", "capital_gains"];
  var tag = prompt("Set tax tag:\n" + tags.join(", "));
  if (!tag || !tags.includes(tag)) return;
  var res = await apiFetch("/api/tax/tag?transaction_id=" + txId + "&tag=" + tag, { method: "POST" });
  if (res.ok) { showToast("Tagged as " + tag, "success"); loadTax(); }
}

async function autoTagTransactions() {
  var year = new Date().getFullYear();
  var res = await apiFetch("/api/tax/auto-tag?year=" + year, { method: "POST" });
  if (res.ok) {
    var data = await res.json();
    showToast("Auto-tagged " + data.tagged + " transactions", "success");
    loadTax();
  }
}

// ── CSV Import Wizard ───────────────────────────────────────
function showImportModal() {
  var existing = document.getElementById("importModal");
  if (existing) existing.remove();
  var modal = document.createElement("div");
  modal.id = "importModal";
  modal.className = "modal-overlay";
  modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
  modal.innerHTML =
    '<div class="modal-content" style="max-width: 600px;">' +
      '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Import Bank Transactions</h3>' +
      // Step indicators
      '<div class="flex gap-2 mb-4 text-xs">' +
        '<span id="csvStep1" class="px-2 py-1 rounded" style="background: var(--primary); color: white;">1. Paste CSV</span>' +
        '<span id="csvStep2" class="px-2 py-1 rounded" style="background: var(--surface); color: var(--text-muted);">2. Map Columns</span>' +
        '<span id="csvStep3" class="px-2 py-1 rounded" style="background: var(--surface); color: var(--text-muted);">3. Import</span>' +
      '</div>' +
      // Step 1: Paste CSV
      '<div id="csvStep1Content">' +
        '<textarea id="csvInput" rows="8" class="input-glow w-full rounded-lg px-3 py-2 text-xs font-mono mb-2" ' +
          'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary); resize: vertical;" ' +
          'placeholder="Paste CSV data here...\nDate,Description,Amount\n2026-01-15,Starbucks,-12.50\n2026-01-16,Paycheck,3500.00"></textarea>' +
        '<div id="csvValidation" class="text-xs mb-3 min-h-[1.2em]"></div>' +
        '<div class="flex gap-2 mb-3">' +
          '<button onclick="loadCSVProfiles()" class="btn-ghost text-xs px-3 py-1.5 rounded-lg">Load Profile</button>' +
        '</div>' +
        '<div class="flex gap-2">' +
          '<button onclick="csvPreview()" id="csvNextBtn" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1" disabled>Preview & Map</button>' +
          '<button onclick="document.getElementById(\'importModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
        '</div>' +
      '</div>' +
      // Step 2: Column mapping (hidden initially)
      '<div id="csvStep2Content" class="hidden"></div>' +
      // Step 3: Import confirm (hidden initially)
      '<div id="csvStep3Content" class="hidden"></div>' +
    '</div>';
  document.body.appendChild(modal);

  // Live validation
  document.getElementById("csvInput").addEventListener("input", function() {
    var csv = this.value.trim();
    var status = document.getElementById("csvValidation");
    var btn = document.getElementById("csvNextBtn");
    if (!csv) { status.innerHTML = ""; btn.disabled = true; return; }
    var lines = csv.split("\n").filter(function(l) { return l.trim(); });
    status.innerHTML = '<span style="color: var(--primary);">' + lines.length + ' row(s) detected</span>';
    btn.disabled = lines.length < 2;
  });
}

async function loadCSVProfiles() {
  try {
    var res = await apiFetch("/api/csv/profiles");
    var data = await res.json();
    var profiles = data.profiles || [];
    if (profiles.length === 0) {
      showToast("No saved profiles", "info");
      return;
    }
    var names = profiles.map(function(p) { return p.name; }).join(", ");
    var name = prompt("Saved profiles: " + names + "\nEnter profile name to load:");
    if (!name) return;
    var profile = profiles.find(function(p) { return p.name === name; });
    if (!profile) { showToast("Profile not found", "error"); return; }
    showToast("Profile loaded: " + name, "success");
  } catch (e) {}
}

async function csvPreview() {
  var csv = document.getElementById("csvInput").value.trim();
  if (!csv) return;
  try {
    var res = await apiFetch("/api/csv/preview", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "csv_text=" + encodeURIComponent(csv),
    });
    var data = await res.json();
    if (!data.headers) { showToast("Could not parse CSV", "error"); return; }

    // Show step 2: column mapping
    document.getElementById("csvStep1Content").classList.add("hidden");
    document.getElementById("csvStep2Content").classList.remove("hidden");
    document.getElementById("csvStep1").style.background = "var(--surface)";
    document.getElementById("csvStep1").style.color = "var(--text-muted)";
    document.getElementById("csvStep2").style.background = "var(--primary)";
    document.getElementById("csvStep2").style.color = "white";

    var headerOpts = data.headers.map(function(h, i) { return '<option value="' + i + '">' + escHtml(h) + '</option>'; }).join("");

    // Preview table
    var previewHtml = '<table class="w-full text-xs border-collapse mb-3"><thead><tr>';
    data.headers.forEach(function(h) { previewHtml += '<th class="text-left px-2 py-1 border-b" style="color: var(--text-muted);">' + escHtml(h) + '</th>'; });
    previewHtml += '</tr></thead><tbody>';
    (data.preview || []).forEach(function(row) {
      previewHtml += '<tr>';
      row.forEach(function(cell) { previewHtml += '<td class="px-2 py-1 border-b" style="color: var(--text-secondary);">' + escHtml(cell) + '</td>'; });
      previewHtml += '</tr>';
    });
    previewHtml += '</tbody></table>';

    document.getElementById("csvStep2Content").innerHTML =
      '<p class="text-xs mb-3" style="color: var(--text-muted);">Map CSV columns to transaction fields:</p>' +
      previewHtml +
      '<div class="grid grid-cols-2 gap-3 mb-3">' +
        '<div><label class="text-xs block mb-1" style="color: var(--text-muted);">Date column</label>' +
          '<select id="csvDateCol" class="w-full rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + headerOpts + '</select></div>' +
        '<div><label class="text-xs block mb-1" style="color: var(--text-muted);">Description column</label>' +
          '<select id="csvDescCol" class="w-full rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + headerOpts + '</select></div>' +
        '<div><label class="text-xs block mb-1" style="color: var(--text-muted);">Amount column</label>' +
          '<select id="csvAmountCol" class="w-full rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' + headerOpts + '</select></div>' +
        '<div><label class="text-xs block mb-1" style="color: var(--text-muted);">Date format</label>' +
          '<select id="csvDateFormat" class="w-full rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' +
            '<option value="YYYY-MM-DD">YYYY-MM-DD</option><option value="MM/DD/YYYY">MM/DD/YYYY</option><option value="DD/MM/YYYY">DD/MM/YYYY</option></select></div>' +
      '</div>' +
      '<div class="grid grid-cols-2 gap-3 mb-3">' +
        '<div><label class="text-xs block mb-1" style="color: var(--text-muted);">Amount sign</label>' +
          '<select id="csvAmountSign" class="w-full rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);">' +
            '<option value="positive">Expenses are negative</option><option value="absolute">All amounts positive (auto-detect)</option></select></div>' +
        '<div><label class="text-xs block mb-1" style="color: var(--text-muted);">Import to account</label>' +
          '<select id="csvAccount" class="w-full rounded-lg px-3 py-2 text-sm" style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);"></select></div>' +
      '</div>' +
      '<div class="flex gap-2">' +
        '<button onclick="csvImport()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1">Import ' + data.total_rows + ' rows</button>' +
        '<button onclick="document.getElementById(\'importModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
      '</div>';

    // Load accounts for dropdown
    var accRes = await apiFetch("/api/accounts");
    var accData = await accRes.json();
    var accSel = document.getElementById("csvAccount");
    (accData.accounts || []).forEach(function(a) {
      var opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name;
      accSel.appendChild(opt);
    });

    // Auto-select likely columns
    var dateIdx = data.headers.findIndex(function(h) { return /date/i.test(h); });
    var descIdx = data.headers.findIndex(function(h) { return /desc|memo|payee|name/i.test(h); });
    var amtIdx = data.headers.findIndex(function(h) { return /amount|debit|credit|total/i.test(h); });
    if (dateIdx >= 0) document.getElementById("csvDateCol").value = dateIdx;
    if (descIdx >= 0) document.getElementById("csvDescCol").value = descIdx;
    if (amtIdx >= 0) document.getElementById("csvAmountCol").value = amtIdx;

  } catch (e) { showToast("Failed to parse CSV", "error"); }
}

async function csvImport() {
  var csv = document.getElementById("csvInput").value.trim();
  var dateCol = parseInt(document.getElementById("csvDateCol").value);
  var descCol = parseInt(document.getElementById("csvDescCol").value);
  var amountCol = parseInt(document.getElementById("csvAmountCol").value);
  var dateFormat = document.getElementById("csvDateFormat").value;
  var amountSign = document.getElementById("csvAmountSign").value;
  var accountId = parseInt(document.getElementById("csvAccount").value);

  // Show step 3: importing
  document.getElementById("csvStep2Content").classList.add("hidden");
  document.getElementById("csvStep3Content").classList.remove("hidden");
  document.getElementById("csvStep3Content").innerHTML = '<p class="text-xs py-4" style="color: var(--text-muted);">Importing...</p>';
  document.getElementById("csvStep2").style.background = "var(--surface)";
  document.getElementById("csvStep2").style.color = "var(--text-muted)";
  document.getElementById("csvStep3").style.background = "var(--primary)";
  document.getElementById("csvStep3").style.color = "white";

  try {
    var params = "csv_text=" + encodeURIComponent(csv) +
      "&date_col=" + dateCol + "&desc_col=" + descCol + "&amount_col=" + amountCol +
      "&date_format=" + dateFormat + "&amount_positive=" + amountSign +
      "&account_id=" + accountId;
    var res = await apiFetch("/api/csv/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    var data = await res.json();
    document.getElementById("importModal").remove();
    if (data.success) {
      showToast("Imported " + data.imported + " transactions" + (data.skipped > 0 ? ", skipped " + data.skipped : ""), "success");
      loadDashboard();
      loadTransactions();
    } else {
      showToast(data.message || "Import failed", "error");
    }
  } catch (e) {
    showToast("Import failed", "error");
    document.getElementById("importModal").remove();
  }
}

// ── Audit Trail Tab ─────────────────────────────────────────
async function loadAuditTrail() {
  var view = document.getElementById("auditView");
  if (!view) return;
  view.innerHTML = '<div class="flex items-center gap-2 text-xs text-gray-600 py-4">' +
    '<span class="typing-dot inline-block w-1.5 h-1.5 bg-gray-500 rounded-full"></span>' +
    '<span class="ml-1">Loading audit trail...</span></div>';
  try {
    var res = await apiFetch("/api/audit?limit=50");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    var entries = data.entries || [];
    if (entries.length === 0) {
      view.innerHTML = '<div class="text-center py-12 text-gray-600">' +
        '<div class="empty-state-icon mb-3">&#128203;</div>' +
        '<p class="font-medium">No audit entries yet</p>' +
        '<p class="text-xs mt-1 text-gray-700">Approved proposals will appear here</p></div>';
      return;
    }
    var html = '<div class="space-y-2">';
    entries.forEach(function(e) {
      var isRestore = e.action_index === -1;
      var cellDisplay = isRestore
        ? '<span class="text-ledger-warn font-medium">Undo</span>'
        : '<span class="font-mono text-gray-400">' + escHtml(e.cell_ref || "—") + '</span>';
      var valueDisplay = "";
      if (isRestore) {
        valueDisplay = '<span class="text-xs text-gray-500">Restored ledger to previous state</span>';
      } else if (e.old_value && e.new_value) {
        valueDisplay =
          '<span class="text-ledger-danger line-through text-xs">' + escHtml(e.old_value) + '</span>' +
          '<span class="text-gray-600 text-xs"> &rarr; </span>' +
          '<span class="text-ledger-success text-xs">' + escHtml(e.new_value) + '</span>';
      } else if (e.new_value) {
        valueDisplay = '<span class="text-ledger-success text-xs">' + escHtml(e.new_value) + '</span>';
      }
      var time = e.executed_at ? e.executed_at.replace("T", " ").slice(0, 19) : "";
      html +=
        '<div class="audit-row p-3 rounded-lg cursor-pointer" onclick="loadProposal(' + e.proposal_id + ')">' +
          '<div class="flex items-center gap-2 mb-1">' +
            '<span class="text-xs text-gray-600 font-mono">' + escHtml(time) + '</span>' +
            '<span class="text-xs font-mono px-1.5 py-0.5 rounded bg-ledger-accent/10 text-ledger-accent">#' + e.proposal_id + '</span>' +
            '<span class="text-xs text-gray-500">' + escHtml(e.sheet) + '</span>' +
            cellDisplay +
          '</div>' +
          '<div>' + valueDisplay + '</div>' +
        '</div>';
    });
    html += '</div>';
    view.innerHTML = html;
  } catch (err) {
    view.innerHTML = '<p class="text-sm text-ledger-danger">Failed to load audit trail.</p>';
  }
}

// ── Extended Tabs ───────────────────────────────────────────
var _allTabIds = ["tabDashboard", "tabProposal", "tabRecurring", "tabBudgets", "tabTransactions", "tabTax", "tabAccounts", "tabCategories", "tabLedger", "tabAudit"];
var _allViewIds = ["dashboardView", "proposalView", "recurringView", "budgetsView", "transactionView", "taxView", "accountsView", "categoriesView", "ledgerView", "auditView"];
var _idleClass = "px-4 py-3 font-medium border-b-2 border-transparent transition";
var _activeClass = "tab-active px-4 py-3 font-medium transition";

function _resetAllTabs() {
  _allTabIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.className = _idleClass;
  });
  _allViewIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
}

switchTab = function(tab) {
  _resetAllTabs();
  var tabId = "tab" + tab.charAt(0).toUpperCase() + tab.slice(1);
  var viewId = tab + "View";
  var tabEl = document.getElementById(tabId);
  var viewEl = document.getElementById(viewId);
  if (tabEl) tabEl.className = _activeClass;
  if (viewEl) viewEl.classList.remove("hidden");

  if (tab === "dashboard") loadDashboard();
  else if (tab === "ledger") loadLedgerPreview();
  else if (tab === "transactions") loadTransactions();
  else if (tab === "accounts") loadAccounts();
  else if (tab === "categories") loadCategories();
  else if (tab === "recurring") loadRecurring();
  else if (tab === "budgets") loadBudgets();
  else if (tab === "tax") loadTax();
  else if (tab === "audit") loadAuditTrail();
};

// Initialize action buttons on load
renderActionButtons();

// Restore session state on page refresh
loadSession();
if (historyOpen) {
  var panel = document.getElementById("historyPanel");
  var arrow = document.getElementById("historyArrow");
  if (panel) panel.classList.remove("hidden");
  if (arrow) arrow.innerHTML = "&#9660;";
  loadHistory(true);
}
if (currentProposalId) {
  loadProposal(currentProposalId);
} else {
  // Default to dashboard tab
  switchTab("dashboard");
}
