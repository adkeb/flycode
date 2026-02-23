const summaryEl = document.getElementById("summary") as HTMLPreElement;
const approveBtn = document.getElementById("approveBtn") as HTMLButtonElement;
const denyBtn = document.getElementById("denyBtn") as HTMLButtonElement;

const url = new URL(window.location.href);
const requestId = url.searchParams.get("requestId") ?? "";
const summary = url.searchParams.get("summary") ?? "(no summary provided)";

summaryEl.textContent = summary;

approveBtn.addEventListener("click", () => {
  void submitDecision(true);
});

denyBtn.addEventListener("click", () => {
  void submitDecision(false);
});

async function submitDecision(approved: boolean): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "FLYCODE_CONFIRM_DECISION",
    requestId,
    approved
  });

  window.close();
}
