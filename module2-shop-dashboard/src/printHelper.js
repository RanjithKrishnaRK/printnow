// src/printHelper.js
//
// "Send to printer" used to only change the job's status - it never
// actually opened the file. This closes that gap for the MANUAL (no agent)
// path: it fetches the PDF, opens it in a new tab, and triggers the
// browser's print dialog automatically, so the shop owner doesn't have to
// separately click "View file" and then Ctrl+P themselves.
//
// Real, hard limit worth being upfront about: no browser lets a webpage
// silently send a job to the printer - the final click in the OS/browser
// print dialog is a security boundary no website can bypass. This gets the
// dialog open automatically with zero extra clicks beforehand; the shop
// owner still has to click "Print" in that dialog and choose
// copies/duplex/color there themselves (those exact values are shown right
// on the job card next to the button, so it's a quick glance-and-match, not
// a guess). For truly hands-off printing with no dialog at all, that's what
// the Module 6 print agent is for.
//
// Why fetch-then-blob instead of just window.open(fileUrl): fileUrl points
// at the backend's own origin (a different port in dev), and cross-origin
// popups can't be told to print() by the page that opened them - the
// browser blocks that call for security. A blob: URL, though, is
// same-origin to whatever page created it, so printing it back is allowed.
export async function openFileAndPrint(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error("Could not load the file to print.");
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);

  const printWindow = window.open(blobUrl, "_blank");
  if (!printWindow) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(
      "Pop-up blocked - allow pop-ups for this site so the print dialog can open automatically."
    );
  }

  let triggered = false;
  const triggerPrint = () => {
    if (triggered) return;
    triggered = true;
    printWindow.print();
    // Release the blob a little after printing, not immediately - revoking
    // it too early can blank out the tab the shop owner is still looking at.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  };

  printWindow.addEventListener("load", triggerPrint);
  // Fallback: some browsers' built-in PDF viewers don't reliably fire
  // "load" on the opener's handle, so print anyway after a short delay if
  // it hasn't fired yet.
  setTimeout(triggerPrint, 1200);
}
