let currentAmcFileName = '';

setupDropZone(document.getElementById('amcFileInput'));

// Converts AMC text to a CIF in the AMC -> CIF box and shows its unit cell, for a
// dropped .amc file or the AMC file of the record fetched from the API.
function showCifFromAmc(fileName, text, doneMessage = '') {
  currentAmcFileName = fileName;
  const status = document.getElementById('amcToCifStatus');
  const output = document.getElementById('amcToCifOutput');
  try {
    output.value = toAscii(buildCifFromAmc(text));
    status.textContent = doneMessage;
  } catch (err) {
    output.value = '';
    status.textContent = `Error: ${err.message}`;
  }
  autoSizeTextarea(output);
  updateSendAmcToCifBtn();
  renderUnitCell(fileName, () => unitCellFromAmc(text));
}

// The record's "AMC File Contents" field is the whole AMC file as text. Named the
// way AMCSD names its downloads ("Mineral__<code>.amc").
function showCifFromApiRecord(apiRecord) {
  const text = getApiField(apiRecord, 'AMC File Contents');
  if (!text) return;
  const name = [getApiField(apiRecord, 'Mineral'), getApiField(apiRecord, 'database_code_amcsd')].filter(Boolean).join('__');
  showCifFromAmc(`${name || 'record'}.amc`, text, "Made from the record's AMC file.");
}

document.getElementById('amcFileInput').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => showCifFromAmc(file.name, reader.result);
  reader.readAsText(file);
});

document.getElementById('copyAmcToCifBtn').addEventListener('click', () => copyTextarea('amcToCifOutput'));

// An "are you sure" box over a dimmed page, drawn by the page itself (the browser's own confirm()
// looks different everywhere and some embedded browsers block it). Resolves true for the confirm
// button; Cancel, Escape or a click on the dimmed page resolve false. Cancel has the focus first,
// so a stray Enter doesn't send.
function confirmOverlay({ title, body, confirmLabel }) {
  return new Promise(resolve => {
    const host = document.querySelector('.cif-viewer-app') || document.body;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const box = document.createElement('div');
    box.className = 'confirm-box';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'confirmOverlayTitle');
    const heading = Object.assign(document.createElement('h3'), { id: 'confirmOverlayTitle', textContent: title });
    const buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel', className: 'confirm-cancel' });
    const ok = Object.assign(document.createElement('button'), { type: 'button', textContent: confirmLabel, className: 'confirm-ok' });
    // The plugin's buttons keep the WordPress theme's look through this class.
    if (host !== document.body) [cancel, ok].forEach(b => b.classList.add('cif-viewer-btn'));
    buttons.append(cancel, ok);
    box.append(heading, body, buttons);
    overlay.append(box);

    const previousFocus = document.activeElement;
    const close = answer => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(answer);
    };
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
      } else if (event.key === 'Tab') {
        // Keep the focus on the two buttons while the box is open.
        event.preventDefault();
        (document.activeElement === cancel ? ok : cancel).focus();
      }
    };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    overlay.addEventListener('click', event => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey, true);
    host.append(overlay);
    cancel.focus();
  });
}

// Send is only usable with a CIF in the box and a record (?UUID=) to send it to.
function updateSendAmcToCifBtn() {
  document.getElementById('sendAmcToCifBtn').disabled = !recordId || !document.getElementById('amcToCifOutput').value;
}

// Sends the CIF to the record in the page URL (Minimal CIF file and Minimal CIF Contents text),
// after asking first.
document.getElementById('sendAmcToCifBtn').addEventListener('click', async () => {
  const text = document.getElementById('amcToCifOutput').value;
  if (!recordId || !text) return;
  const uuid = recordId.trim();
  const message = document.createElement('p');
  message.append(
    'It replaces the minimal CIF of record ',
    Object.assign(document.createElement('code'), { textContent: uuid }),
    ': both the Minimal CIF file and the Minimal CIF Contents text. The old ones can\'t be brought back.',
  );
  const sure = await confirmOverlay({
    title: 'Are you sure you want to send this CIF to the database?',
    body: message,
    confirmLabel: 'Yes, send it',
  });
  if (!sure) return;

  const button = document.getElementById('sendAmcToCifBtn');
  const status = document.getElementById('sendAmcToCifStatus');
  button.disabled = true;
  status.textContent = 'Sending...';
  try {
    const { replaced, fileName } = await sendMinimalCif(uuid, text);
    // ODR prepares a new file in the background, so its download can fail for a little while.
    status.textContent = (replaced
      ? `Sent as ${fileName}. It replaced the old minimal CIF.`
      : `Sent as ${fileName}.`) +
      ' The download may take a moment to be ready: if it gives an error at first, wait a bit and try again.';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    updateSendAmcToCifBtn();
  }
});
