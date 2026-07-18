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

// ── Feature 1: CSV Import ──────────────────────────────────
function showImportModal() {
  var existing = document.getElementById("importModal");
  if (existing) existing.remove();
  var modal = document.createElement("div");
  modal.id = "importModal";
  modal.className = "modal-overlay";
  modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
  modal.innerHTML =
    '<div class="modal-content">' +
      '<h3 class="text-sm font-semibold mb-3" style="color: var(--text-primary);">Import Bank Transactions</h3>' +
      '<p class="text-xs mb-3" style="color: var(--text-muted);">Paste CSV with columns: <strong>Date, Description, Amount</strong></p>' +
      '<textarea id="csvInput" rows="8" class="input-glow w-full rounded-lg px-3 py-2 text-xs font-mono mb-2" ' +
        'style="background: var(--surface); border: 1px solid var(--border); color: var(--text-primary); resize: vertical;" ' +
        'placeholder="Date,Description,Amount&#10;2025-06-11,Office Supplies,-1200.00&#10;2025-06-12,Client Payment,3500.00" ' +
        'oninput="validateCSVImport()"></textarea>' +
      '<div id="csvValidation" class="text-xs mb-3 min-h-[1.2em]"></div>' +
      '<div class="flex gap-2">' +
        '<button id="csvImportBtn" onclick="submitCSVImport()" class="btn-primary px-4 py-2 rounded-lg text-xs flex-1" disabled>Import & Propose</button>' +
        '<button onclick="document.getElementById(\'importModal\').remove()" class="btn-ghost px-4 py-2 rounded-lg text-xs">Cancel</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);
}

function validateCSVImport() {
  var input = document.getElementById("csvInput");
  var status = document.getElementById("csvValidation");
  var btn = document.getElementById("csvImportBtn");
  if (!input || !status) return;
  var csv = input.value.trim();
  if (!csv) {
    status.innerHTML = '<span style="color: var(--text-muted);">Paste your CSV data above</span>';
    btn.disabled = true;
    return;
  }
  var lines = csv.split("\n").filter(function(l) { return l.trim(); });
  var valid = 0, invalid = 0;
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split(",").map(function(p) { return p.trim(); });
    if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) && !isNaN(parseFloat(parts[2]))) {
      valid++;
    } else {
      invalid++;
    }
  }
  if (valid > 0 && invalid === 0) {
    status.innerHTML = '<span style="color: #16a34a;">&#10003; ' + valid + ' valid transaction(s) ready</span>';
    btn.disabled = false;
  } else if (valid > 0) {
    status.innerHTML = '<span style="color: #d97706;">&#9888; ' + valid + ' valid, ' + invalid + ' invalid row(s) (will be skipped)</span>';
    btn.disabled = false;
  } else {
    status.innerHTML = '<span style="color: #e11d48;">&#10005; No valid rows found. Use format: Date,Description,Amount</span>';
    btn.disabled = true;
  }
}

async function submitCSVImport() {
  var csv = document.getElementById("csvInput").value.trim();
  if (!csv) { showToast("Please paste CSV data", "error"); return; }
  document.getElementById("importModal").remove();
  chatInput.value = "Import these bank transactions:\n" + csv;
  chatForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

// ── Dashboard ───────────────────────────────────────────────
async function loadDashboard() {
  var view = document.getElementById("dashboardView");
  view.innerHTML = '<div class="flex items-center gap-2 text-xs py-4" style="color: var(--text-muted);">' +
    '<span class="typing-dot inline-block w-1.5 h-1.5 rounded-full" style="background: var(--text-muted);"></span>' +
    '<span>Loading dashboard...</span></div>';
  try {
    var res = await apiFetch("/api/dashboard");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var d = await res.json();

    // Account cards
    var accountsHtml = (d.accounts || []).map(function(a) {
      var color = a.balance >= 0 ? "var(--success)" : "var(--danger)";
      return '<div class="dash-card">' +
        '<p class="text-xs" style="color: var(--text-muted);">' + escHtml(a.name) + '</p>' +
        '<p class="text-lg font-bold font-mono mt-1" style="color: ' + color + ';">$' + Math.abs(a.balance).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p>' +
        '<p class="text-xs mt-0.5" style="color: var(--text-muted);">' + escHtml(a.type) + '</p>' +
      '</div>';
    }).join("");

    // Summary
    var s = d.summary || {};
    var netColor = (s.net || 0) >= 0 ? "var(--success)" : "var(--danger)";

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
        // Account cards
        '<div class="flex gap-3 mb-6 flex-wrap">' + accountsHtml + '</div>' +
        // Summary + chart row
        '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">' +
          '<div class="dash-card">' +
            '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">' + escHtml(s.period || "This Month") + '</p>' +
            '<div class="flex gap-4">' +
              '<div><p class="text-xs" style="color: var(--text-muted);">Income</p><p class="text-sm font-bold font-mono" style="color: var(--success);">$' + (s.total_income || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
              '<div><p class="text-xs" style="color: var(--text-muted);">Expenses</p><p class="text-sm font-bold font-mono" style="color: var(--danger);">$' + (s.total_expenses || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
              '<div><p class="text-xs" style="color: var(--text-muted);">Net</p><p class="text-sm font-bold font-mono" style="color: ' + netColor + ';">$' + (s.net || 0).toLocaleString(undefined, {minimumFractionDigits: 2}) + '</p></div>' +
            '</div>' +
          '</div>' +
          '<div class="dash-card">' +
            '<p class="text-xs font-medium mb-3" style="color: var(--text-muted);">Spending by Category</p>' +
            (catHtml || '<p class="text-xs" style="color: var(--text-muted);">No expenses this month</p>') +
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
var _allTabIds = ["tabDashboard", "tabProposal", "tabLedger", "tabTransactions", "tabAccounts", "tabCategories", "tabAudit"];
var _allViewIds = ["dashboardView", "proposalView", "ledgerView", "transactionView", "accountsView", "categoriesView", "auditView"];
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
