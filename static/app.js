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
function showToast(message, type) {
  var styles = {
    success: "background: var(--gradient-success); box-shadow: 0 4px 16px rgba(34,197,94,0.3);",
    error: "background: var(--gradient-danger); box-shadow: 0 4px 16px rgba(239,68,68,0.3);",
    info: "background: var(--gradient-blue); box-shadow: 0 4px 16px rgba(59,130,246,0.3);",
  };
  var icons  = { success: "&#10003;", error: "&#10005;", info: "&#9432;" };
  var el = document.createElement("div");
  el.className = "toast fixed bottom-6 right-6 text-white px-4 py-3 rounded-xl text-sm z-50 flex items-center gap-2 font-medium";
  el.style.cssText = styles[type] || styles.info;
  el.innerHTML = "<span>" + (icons[type] || icons.info) + "</span><span>" + escHtml(message) + "</span>";
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 3000);
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
function addMessage(role, text, proposalId) {
  // Hide example prompts once the conversation starts
  var examples = document.getElementById("examplePromptsWrap");
  if (examples) examples.style.display = "none";

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
      '<div class="w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5" style="background: rgba(59,130,246,0.15); color: #60a5fa;">AI</div>' +
      '<div class="' + bubbleClass + ' px-4 py-3 max-w-[85%] text-sm">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<div class="flex-1 md-content">' + icon + rendered + badge + '</div>' +
          '<button class="copy-btn shrink-0 text-gray-600 hover:text-gray-300 text-xs px-1 py-0.5 rounded transition" onclick="copyMessage(this)" title="Copy to clipboard">&#128203;</button>' +
        '</div>' +
      '</div>';
  }

  wrapper.innerHTML = contentHtml;
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Copy message to clipboard
function copyMessage(btn) {
  var msgEl = btn.closest(".msg-wrapper");
  var textEl = msgEl.querySelector(".md-content") || msgEl.querySelector("[class*='rounded-xl']");
  if (!textEl) return;
  var text = textEl.innerText || textEl.textContent;
  navigator.clipboard.writeText(text).then(function() {
    showToast("Copied to clipboard", "success");
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
var _t10, _t60;
function showLoading() {
  sendBtn.disabled = true;
  chatInput.disabled = true;

  _t10 = setTimeout(function() {
    var cap = document.getElementById("typingCaption");
    if (cap) { cap.textContent = "Still thinking…"; cap.classList.remove("hidden"); }
  }, 10000);

  _t60 = setTimeout(function() {
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
  chatMessages.scrollTop = chatMessages.scrollHeight;
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
  var msg = chatInput.value.trim();
  if (!msg) return;

  chatInput.value = "";
  addMessage("user", msg);
  showLoading();
  showTyping();

  try {
    var res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });

    hideTyping();
    hideLoading();
    if (!res.ok) {
      addMessage("assistant", "Server error (" + res.status + "). Please try again.");
      return;
    }
    var data = await res.json();
    addMessage("assistant", data.assistant_message, data.proposal_id);

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
    var res = await fetch("/api/proposals/" + id);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var p = await res.json();

    currentProposalId = p.status === "pending" ? id : null;

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
      btn.className = "btn-gradient flex-1 py-3 rounded-xl text-sm transition";
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
    var res = await fetch("/api/proposals/" + id + "/approve", { method: "POST" });
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
      showToast("Proposal approved and executed", "success");
      currentProposalId = null;
      if (!historyOpen) toggleHistory();
      else loadHistory();
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
    var res = await fetch("/api/proposals/" + id + "/reject", { method: "POST" });
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
      if (!historyOpen) toggleHistory();
      else loadHistory();
      loadProposal(id);
    }
  } catch (err) {
    btns.innerHTML = '<p class="text-sm text-ledger-danger">Request failed</p>';
    showToast("Could not reach the server", "error");
  }
}

// Past proposals history panel
async function loadHistory() {
  var panel = document.getElementById("historyPanel");
  panel.innerHTML = '<p class="text-xs text-gray-600 animate-pulse">Loading...</p>';
  try {
    var res = await fetch("/api/proposals?limit=10");
    var data = await res.json();
    var proposals = data.proposals || [];
    if (proposals.length === 0) {
      panel.innerHTML = '<p class="text-xs text-gray-600">No proposals yet.</p>';
      return;
    }
    panel.innerHTML = proposals.map(function(p) {
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
  } catch (err) {
    panel.innerHTML = '<p class="text-xs text-ledger-danger">Failed to load history.</p>';
  }
}

function toggleHistory() {
  historyOpen = !historyOpen;
  var panel = document.getElementById("historyPanel");
  var arrow = document.getElementById("historyArrow");
  if (historyOpen) {
    panel.classList.remove("hidden");
    arrow.innerHTML = "&#9660;";
    loadHistory();
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
  var active = "border-ledger-accent text-white";
  var idle = "border-transparent text-gray-500 hover:text-gray-300";
  if (tab === "ledger") {
    pv.classList.add("hidden");
    lv.classList.remove("hidden");
    tl.className = "px-5 py-3 font-medium border-b-2 transition " + active;
    tp.className = "px-5 py-3 font-medium border-b-2 transition " + idle;
    loadLedgerPreview();
  } else {
    lv.classList.add("hidden");
    pv.classList.remove("hidden");
    tp.className = "px-5 py-3 font-medium border-b-2 transition " + active;
    tl.className = "px-5 py-3 font-medium border-b-2 transition " + idle;
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
    var res = await fetch("/api/ledger/preview?sheet=" + encodeURIComponent(ledgerSheet) + "&limit=100");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();

    var tabs = (data.sheets || [ledgerSheet]).map(function(s) {
      var cls = s === data.sheet
        ? "btn-gradient text-xs px-3 py-1.5 rounded-lg"
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

    var thead = '<tr>' + data.headers.map(function(h) {
      return '<th class="text-left px-2 py-1 border-b border-ledger-border text-gray-400 font-medium sticky top-0 bg-ledger-surface">' + escHtml(h) + '</th>';
    }).join("") + '</tr>';

    var tbody = data.rows.map(function(row) {
      return '<tr class="hover:bg-ledger-surface/50">' + row.map(function(cell) {
        return '<td class="px-2 py-1 border-b border-ledger-border/40 font-mono text-gray-300">' + escHtml(cell == null ? "" : cell) + '</td>';
      }).join("") + '</tr>';
    }).join("");

    view.innerHTML =
      '<div class="flex gap-2 mb-3 flex-wrap">' + tabs + '</div>' +
      '<div class="overflow-x-auto"><table class="w-full text-xs border-collapse min-w-[600px]">' +
        '<thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' +
      '<p class="text-xs text-gray-600 mt-3">Showing up to 100 rows. Download for the full file.</p>';
  } catch (err) {
    view.innerHTML = '<p class="text-sm text-ledger-danger">Failed to load ledger preview.</p>';
  }
}

// Undo (restore from snapshot)
async function restoreProposal(id) {
  if (!confirm("Restore the ledger to its state before proposal #" + id + "? This overwrites the current ledger.")) return;
  try {
    var res = await fetch("/api/proposals/" + id + "/restore", { method: "POST" });
    var data = await res.json();
    if (res.ok && data.success) {
      showToast("Ledger restored (before #" + id + ")", "success");
      addMessage("assistant", "Ledger restored to the state before proposal #" + id + ".");
      if (!document.getElementById("ledgerView").classList.contains("hidden")) loadLedgerPreview();
      if (historyOpen) loadHistory();
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
    var res = await fetch("/api/chat/history");
    var data = await res.json();
    if (data.messages && data.messages.length > 0) {
      chatMessages.innerHTML = "";
      data.messages.forEach(function(m) {
        addMessage(m.role, m.content, m.proposal_id);
      });
    }
  } catch (err) {
    console.error("Failed to load chat history", err);
  }
})();
