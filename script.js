const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const openImageBtn = document.getElementById('openImageBtn');
const rescanButton = document.getElementById('rescanButton');
const cleanButton = document.getElementById('cleanButton');
const downloadCleanButton = document.getElementById('downloadCleanButton');
const themeToggle = document.getElementById('themeToggle');
const previewImage = document.getElementById('previewImage');
const previewClean = document.getElementById('previewClean');
const fileTypeHint = document.getElementById('fileTypeHint');
const imageCaption = document.getElementById('imageCaption');
const uploadProgress = document.getElementById('uploadProgress');
const cancelUploadBtn = document.getElementById('cancelUpload');
const uploadStatus = document.getElementById('uploadStatus');
const exportReport = document.getElementById('exportReport');
const totalScans = document.getElementById('totalScans');
const highRiskCount = document.getElementById('highRiskCount');
const cleanedCount = document.getElementById('cleanedCount');
const batchQueue = document.getElementById('batchQueue');
const queueCount = document.getElementById('queueCount');

// Metadata control checkboxes
const removeGPS = document.getElementById('remove-gps');
const removeDevice = document.getElementById('remove-device');
const removeDateTime = document.getElementById('remove-datetime');
const removeAuthor = document.getElementById('remove-author');
const removeAnnotations = document.getElementById('remove-annotations');
const enableBlur = document.getElementById('enable-blur');

const cameraModelValue = document.getElementById('cameraModelValue');
const dateTimeValue = document.getElementById('dateTimeValue');
const gpsValue = document.getElementById('gpsValue');
const deviceValue = document.getElementById('deviceValue');
const apertureValue = document.getElementById('apertureValue');
const focalLengthValue = document.getElementById('focalLengthValue');
const isoValue = document.getElementById('isoValue');
const dimensionsValue = document.getElementById('dimensionsValue');
const fileSizeValue = document.getElementById('fileSizeValue');
const fileTypeValue = document.getElementById('fileTypeValue');
const riskScore = document.getElementById('riskScore');
const riskLabel = document.getElementById('riskLabel');
const riskSummaryText = document.getElementById('riskSummaryText');
const locationDataStatus = document.getElementById('locationDataStatus');
const deviceInfoStatus = document.getElementById('deviceInfoStatus');
const dateTimeStatus = document.getElementById('dateTimeStatus');
const otherMetadataStatus = document.getElementById('otherMetadataStatus');
const serverNotice = document.getElementById('serverNotice');
const serverStatusBadge = document.getElementById('serverStatusBadge');
const startServerBtn = document.getElementById('startServerBtn');
const dismissServerNotice = document.getElementById('dismissServerNotice');
const annotationsValue = document.getElementById('annotationsValue');
const formFieldsValue = document.getElementById('formFieldsValue');
const hiddenLayersValue = document.getElementById('hiddenLayersValue');

let currentFile = null;
let cleanedFileUrl = null;
let xhrUpload = null;
let cleanedFilesCount = 0;
let fileQueue = []; // batch processing queue
let isProcessingBatch = false;
const isLocalFile = window.location.protocol === 'file:';
const isHttpUrl = window.location.protocol === 'http:' || window.location.protocol === 'https:';
const savedApi = localStorage.getItem('meta_api') || '';
const DEFAULT_LOCAL_API_BASE = 'http://localhost:3000';
let apiBase = savedApi || '';
let serverAvailable = false;

// Console helper to set API base URL (kept off-screen). Use from browser console:
// window.setMetaApiBase('http://example.com')
window.setMetaApiBase = (u) => {
  try {
    if (u) {
      localStorage.setItem('meta_api', u);
      apiBase = u;
    } else {
      localStorage.removeItem('meta_api');
      apiBase = isLocalFile ? 'http://localhost:3000' : '';
    }
    try { checkServerAvailability(); fetchTips(); fetchHistory(); } catch (e) {}
    setActionButtonState();
    return true;
  } catch (e) { console.warn(e); return false; }
};

const getApiBaseUrl = (path) => {
  if (apiBase) return `${apiBase}${path}`;
  if (isHttpUrl) return path;
  return `${DEFAULT_LOCAL_API_BASE}${path}`;
};

const detectLocalServer = async () => {
  if (!isLocalFile) return false;
  const candidate = savedApi || DEFAULT_LOCAL_API_BASE;
  try {
    const res = await fetch(`${candidate}/api/tips`, { method: 'GET' });
    if (res.ok) {
      apiBase = candidate;
      serverAvailable = true;
      setActionButtonState();
      showServerNotice(false);
      return true;
    }
  } catch (e) {
    serverAvailable = false;
  }
  return false;
};

const getFileSizeString = (bytes) => {
  if (!bytes && bytes !== 0) return 'Unknown';
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const calculateOfflineRisk = (metadata, details) => {
  let score = 10;
  if (details.locationData && details.locationData !== 'Not detected offline') score += 30;
  if (details.deviceInfo && details.deviceInfo !== 'Not detected offline') score += 20;
  if (details.dateTime && details.dateTime !== 'Not detected offline') score += 20;
  if (details.otherMetadata && details.otherMetadata !== 'Limited offline metadata scan') score += 15;
  if (metadata.cameraModel && metadata.cameraModel !== 'Not found' && metadata.cameraModel !== 'Unknown') score += 10;
  if (metadata.annotations && metadata.annotations !== 'Unknown') score += 5;

  if (score >= 70) return { score, level: 'High Risk' };
  if (score >= 40) return { score, level: 'Medium Risk' };
  return { score, level: 'Low Risk' };
};

const getStringFromDB = (view, start, length) => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const char = view.getUint8(start + i);
    if (char === 0) break;
    out += String.fromCharCode(char);
  }
  return out;
};

const parseJpegExif = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const buffer = event.target.result;
      const view = new DataView(buffer);
      if (view.getUint16(0) !== 0xffd8) return resolve(null);
      let offset = 2;
      const length = view.byteLength;
      const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

      while (offset < length) {
        if (view.getUint8(offset) !== 0xff) break;
        const marker = view.getUint8(offset + 1);
        const size = view.getUint16(offset + 2);
        if (marker === 0xe1) {
          const start = offset + 4;
          if (getStringFromDB(view, start, 4) !== 'Exif') return resolve(null);
          const tiffOffset = start + 6;
          const little = getStringFromDB(view, tiffOffset, 2) === 'II';
          const getUint16 = (off) => little ? view.getUint16(off, true) : view.getUint16(off, false);
          const getUint32 = (off) => little ? view.getUint32(off, true) : view.getUint32(off, false);
          const readValue = (type, count, valueOffset, entryOffset) => {
            const valueSize = (typeSizes[type] || 1) * count;
            const valuePos = valueSize > 4 ? tiffOffset + valueOffset : entryOffset + 8;
            if (type === 2) return getStringFromDB(view, valuePos, count).replace(/\0/g, '');
            if (type === 3) {
              if (count === 1) return getUint16(valuePos);
              const vals = [];
              for (let i = 0; i < count; i += 1) vals.push(getUint16(valuePos + i * 2));
              return vals;
            }
            if (type === 4) {
              if (count === 1) return getUint32(valuePos);
              const vals = [];
              for (let i = 0; i < count; i += 1) vals.push(getUint32(valuePos + i * 4));
              return vals;
            }
            if (type === 5) {
              const vals = [];
              let ptr = valuePos;
              for (let i = 0; i < count; i += 1) {
                vals.push(getUint32(ptr) / getUint32(ptr + 4));
                ptr += 8;
              }
              return count === 1 ? vals[0] : vals;
            }
            if (type === 7) {
              if (count === 1) return view.getUint8(valuePos);
              const vals = [];
              for (let i = 0; i < count; i += 1) vals.push(view.getUint8(valuePos + i));
              return vals;
            }
            return null;
          };
          const parseIFD = (dirOffset) => {
            const numEntries = getUint16(dirOffset);
            const tags = {};
            let entryPtr = dirOffset + 2;
            for (let i = 0; i < numEntries; i += 1) {
              const tag = getUint16(entryPtr);
              const type = getUint16(entryPtr + 2);
              const count = getUint32(entryPtr + 4);
              const valueOffset = getUint32(entryPtr + 8);
              tags[tag] = readValue(type, count, valueOffset, entryPtr);
              entryPtr += 12;
            }
            return tags;
          };
          const firstIFD = tiffOffset + getUint32(tiffOffset + 4);
          const tags = parseIFD(firstIFD);
          const gpsPointer = tags[0x8825];
          const gpsTags = gpsPointer ? parseIFD(tiffOffset + gpsPointer) : {};
          const getCoord = (coords, ref) => {
            if (!coords || !coords.length) return null;
            const [deg, min, sec] = coords;
            let value = deg + min / 60 + sec / 3600;
            if (ref === 'S' || ref === 'W') value = -value;
            return Number(value.toFixed(6));
          };
          const gps = gpsTags[0x0002] && gpsTags[0x0003] ? {
            latitude: getCoord(gpsTags[0x0002], gpsTags[0x0001]),
            longitude: getCoord(gpsTags[0x0003], gpsTags[0x0004])
          } : null;
          const cameraModel = [tags[0x010f], tags[0x0110]].filter(Boolean).join(' ').trim() || null;
          const dateTime = tags[0x9003] || tags[0x0132] || null;
          const focalLength = tags[0x920a] ? `${tags[0x920a]} mm` : null;
          const aperture = tags[0x829d] ? `f/${tags[0x829d]}` : null;
          const iso = tags[0x8827] || null;
          resolve({
            cameraModel,
            dateTime,
            gps,
            device: cameraModel,
            aperture,
            focalLength,
            iso,
            any: !!(cameraModel || dateTime || gps)
          });
          return;
        }
        offset += 2 + size;
      }
      resolve(null);
    } catch (error) {
      reject(error);
    }
  };
  reader.onerror = () => reject(new Error('Unable to read file for offline scan'));
  reader.readAsArrayBuffer(file.slice(0, 65536));
});

// Parse PNG textual chunks (tEXt/iTXt)
const parsePngChunks = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const buf = e.target.result;
      const view = new DataView(buf);
      // PNG signature
      if (view.getUint32(0) !== 0x89504e47) return resolve(null);
      let offset = 8;
      const meta = {};
      while (offset < view.byteLength) {
        const length = view.getUint32(offset); offset += 4;
        const type = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3)); offset += 4;
        if (type === 'tEXt' || type === 'iTXt') {
          const chunkBytes = new Uint8Array(buf, offset, length);
          const text = new TextDecoder().decode(chunkBytes);
          const sep = text.indexOf('\0');
          if (sep !== -1) {
            const key = text.slice(0, sep);
            const val = text.slice(sep + 1);
            meta[key] = val;
          } else {
            const parts = text.split(':');
            if (parts.length >= 2) meta[parts[0]] = parts.slice(1).join(':');
          }
        }
        offset += length + 4; // skip data + CRC
      }
      resolve(meta);
    } catch (err) { reject(err); }
  };
  reader.onerror = () => reject(new Error('Unable to read PNG for offline scan'));
  reader.readAsArrayBuffer(file.slice(0, 256 * 1024));
});

// Parse basic PDF Info dictionary by scanning first chunk of file for common keys
const parsePdfInfo = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = new TextDecoder().decode(e.target.result);
      const info = {};
      const match = (k) => {
        const re = new RegExp(`/${k}\s*\(([^\)]*)\)`,'i');
        const m = text.match(re);
        return m ? m[1] : null;
      };
      const keys = ['Title','Author','Creator','Producer','CreationDate','ModDate','Subject'];
      keys.forEach((k) => { const v = match(k); if (v) info[k] = v; });
      resolve(info);
    } catch (err) { reject(err); }
  };
  reader.onerror = () => reject(new Error('Unable to read PDF for offline scan'));
  reader.readAsArrayBuffer(file.slice(0, 1024 * 1024));
});

// Parse Office (OOXML) core properties from docProps/core.xml inside the ZIP container
const parseOfficeCoreProps = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const buf = e.target.result;
      const view = new DataView(buf);
      const textDecoder = new TextDecoder();
      let offset = 0;
      const len = buf.byteLength;
      while (offset + 30 < len) {
        const sig = view.getUint32(offset, true);
        if (sig !== 0x04034b50) { offset += 1; continue; }
        const compMethod = view.getUint16(offset + 8, true);
        const compSize = view.getUint32(offset + 18, true);
        const fileNameLen = view.getUint16(offset + 26, true);
        const extraLen = view.getUint16(offset + 28, true);
        const nameStart = offset + 30;
        const name = textDecoder.decode(new Uint8Array(buf, nameStart, fileNameLen));
        const dataStart = nameStart + fileNameLen + extraLen;
        if (name === 'docProps/core.xml') {
          const compBytes = new Uint8Array(buf, dataStart, compSize);
          let xmlText = null;
          if (compMethod === 0) {
            xmlText = textDecoder.decode(compBytes);
          } else if (compMethod === 8 && typeof DecompressionStream !== 'undefined') {
            try {
              const ds = new DecompressionStream('deflate-raw');
              xmlText = await new Response(new Blob([compBytes]).stream().pipeThrough(ds)).text();
            } catch (e) {
              return resolve(null);
            }
          } else {
            return resolve(null);
          }
          const getTag = (rx) => { const m = xmlText.match(rx); return m ? m[1] : null; };
          const creator = getTag(/<dc:creator>([^<]*)<\/dc:creator>/i);
          const title = getTag(/<dc:title>([^<]*)<\/dc:title>/i);
          const created = getTag(/<dcterms:created[^>]*>([^<]*)<\/dcterms:created>/i) || getTag(/<cp:created[^>]*>([^<]*)<\/cp:created>/i);
          return resolve({ Creator: creator, Title: title, Created: created });
        }
        offset = dataStart + compSize + 4; // move past data + CRC
      }
      resolve(null);
    } catch (err) { reject(err); }
  };
  reader.onerror = () => reject(new Error('Unable to read file for office scan'));
  reader.readAsArrayBuffer(file);
});

const scanFileOffline = async (file) => {
  const metadata = {
    cameraModel: 'Not found',
    dateTime: 'Unknown',
    gpsLocation: 'Not found',
    device: 'Not found',
    aperture: '—',
    focalLength: '—',
    iso: '—',
    dimensions: file.type.startsWith('image/') ? `${file.type.replace('image/', '').toUpperCase()} image` : 'Unknown',
    annotations: 'Unknown',
    formFields: 'Unknown',
    hiddenLayers: 'Unknown'
  };
  const details = {
    locationData: 'Not detected offline',
    deviceInfo: 'Not detected offline',
    dateTime: 'Not detected offline',
    otherMetadata: 'Limited offline metadata scan'
  };
  if (file.type === 'image/jpeg') {
    try {
      const exif = await parseJpegExif(file);
      if (exif) {
        if (exif.cameraModel) metadata.cameraModel = exif.cameraModel;
        if (exif.dateTime) metadata.dateTime = exif.dateTime;
        if (exif.gps) {
          const loc = `${exif.gps.latitude}, ${exif.gps.longitude}`;
          metadata.gpsLocation = loc;
          details.locationData = loc;
        }
        if (exif.device) metadata.device = exif.device;
        if (exif.aperture) metadata.aperture = exif.aperture;
        if (exif.focalLength) metadata.focalLength = exif.focalLength;
        if (exif.iso) metadata.iso = exif.iso;
        if (exif.dateTime) details.dateTime = exif.dateTime;
        details.deviceInfo = exif.device ? exif.device : details.deviceInfo;
        details.otherMetadata = exif.any ? 'JPEG EXIF metadata found' : 'No EXIF metadata found';
      }
    } catch (e) {
      console.warn('Offline scan parse error', e);
    }
  }
  // PNG: parse tEXt / iTXt / zTXt chunks for textual metadata
  if (file.type === 'image/png') {
    try {
      const pngMeta = await parsePngChunks(file);
      if (pngMeta) {
        if (pngMeta.Title) metadata.cameraModel = pngMeta.Title;
        if (pngMeta.Author) metadata.device = pngMeta.Author;
        if (pngMeta.Description) metadata.annotations = pngMeta.Description;
        details.otherMetadata = Object.keys(pngMeta).length ? 'PNG textual metadata found' : details.otherMetadata;
      }
    } catch (e) { console.warn('PNG parse error', e); }
  }

  // PDF: scan document info dictionary for author/title/creation
  if (file.type === 'application/pdf') {
    try {
      const pdfInfo = await parsePdfInfo(file);
      if (pdfInfo) {
        if (pdfInfo.Author) metadata.device = pdfInfo.Author;
        if (pdfInfo.Title) metadata.cameraModel = pdfInfo.Title;
        if (pdfInfo.CreationDate) metadata.dateTime = pdfInfo.CreationDate;
        details.otherMetadata = Object.keys(pdfInfo).length ? 'PDF info dictionary found' : details.otherMetadata;
      }
    } catch (e) { console.warn('PDF parse error', e); }
  }
  // Office OpenXML: docx/pptx/xlsx — extract core properties from docProps/core.xml
  if (file.name && file.name.match(/\.docx$|\.pptx$|\.xlsx$/i)) {
    try {
      const officeInfo = await parseOfficeCoreProps(file);
      if (officeInfo) {
        if (officeInfo.Creator) metadata.device = officeInfo.Creator;
        if (officeInfo.Title) metadata.cameraModel = officeInfo.Title;
        if (officeInfo.Created) metadata.dateTime = officeInfo.Created;
        details.otherMetadata = officeInfo.Creator || officeInfo.Title || officeInfo.Created ? 'Office core properties found' : details.otherMetadata;
      }
    } catch (e) { console.warn('Office parse error', e); }
  }
  const risk = calculateOfflineRisk(metadata, details);
  return {
    type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'document',
    fileSize: getFileSizeString(file.size),
    metadata,
    details,
    risk,
    _source: 'offline'
  };
};

const scanSourceBadge = document.getElementById('scanSourceBadge');
const retryServerBtn = document.getElementById('retryServerBtn');

const setScanSource = (source) => {
  try {
    if (!scanSourceBadge) return;
    scanSourceBadge.textContent = `Source: ${source === 'server' ? 'Server' : source === 'offline' ? 'Offline' : source || '—'}`;
    if (retryServerBtn) retryServerBtn.style.display = (source === 'offline' && apiBase) ? 'inline-flex' : 'none';
  } catch (e) { console.warn(e); }
};

retryServerBtn?.addEventListener('click', async () => {
  if (!currentFile) return;
  if (!apiBase) {
    if (uploadStatus) uploadStatus.textContent = 'No API base configured.';
    return;
  }
  try {
    if (uploadStatus) uploadStatus.textContent = 'Retrying upload to server...';
    const data = await uploadFileToServer(currentFile);
    updateMetadataUI(data);
    setScanSource('server');
    if (uploadStatus) uploadStatus.textContent = 'Server scan complete.';
  } catch (err) {
    console.error('Retry server failed', err);
    if (uploadStatus) uploadStatus.textContent = 'Server retry failed.';
  }
});

const setPreview = (file, url) => {
  const isImage = file.type.startsWith('image/');
  if (isImage) {
    previewImage.classList.remove('file-preview');
    previewImage.textContent = '';
    previewImage.style.backgroundImage = `url('${url}')`;
  } else {
    previewImage.classList.add('file-preview');
    previewImage.textContent = file.name;
    previewImage.style.backgroundImage = 'none';
  }
  previewImage.style.backgroundSize = 'cover';
  previewImage.style.backgroundPosition = 'center';
};

const setCleanPreview = (file, url) => {
  const isImage = file.type.startsWith('image/');
  if (isImage) {
    previewClean.classList.remove('file-preview');
    previewClean.textContent = '';
    previewClean.style.backgroundImage = `url('${url}')`;
  } else {
    previewClean.classList.add('file-preview');
    previewClean.textContent = `Cleaned: ${file.name}`;
    previewClean.style.backgroundImage = 'none';
  }
  previewClean.style.backgroundSize = 'cover';
  previewClean.style.backgroundPosition = 'center';
};

const getFileHint = (type) => {
  switch (type) {
    case 'image':
      return 'Image metadata scan includes camera, GPS, and EXIF details.';
    case 'video':
      return 'Video metadata scan includes format, duration, bitrate, and embedded tags.';
    case 'pdf':
      return 'PDF metadata scan includes page count and document property details.';
    case 'document':
      return 'Document metadata scan includes title, author, and creation details.';
    default:
      return 'Supported file types include images, videos, PDFs, and Office documents.';
  }
};

const updateMetadataUI = (data) => {
  // Populate fields defensively depending on file type
  fileTypeValue.textContent = data.type || 'Unknown';
  fileTypeHint.textContent = getFileHint(data.type);
  cameraModelValue.textContent = data.metadata.cameraModel || data.metadata.format || 'Unknown';
  dateTimeValue.textContent = data.metadata.dateTime || data.metadata.duration || 'Unknown';
  gpsValue.textContent = data.metadata.gpsLocation || (data.metadata.tags && (data.metadata.tags.location || 'Unknown')) || 'Unknown';
  deviceValue.textContent = data.metadata.device || data.metadata.tags?.encoder || 'Unknown';
  apertureValue.textContent = data.metadata.aperture || '—';
  focalLengthValue.textContent = data.metadata.focalLength || '—';
  isoValue.textContent = data.metadata.iso || '—';
  dimensionsValue.textContent = data.metadata.dimensions || data.metadata.pages || 'Unknown';
  fileSizeValue.textContent = data.fileSize || 'Unknown';
  riskScore.textContent = data.risk?.score != null ? data.risk.score : '--';
  riskLabel.textContent = data.risk?.level || 'Unknown';
  riskSummaryText.textContent = data.risk?.level ? `Risk: ${data.risk.level}` : 'Upload a file to inspect metadata and risk.';
  locationDataStatus.textContent = data.details.locationData || 'Unknown';
  deviceInfoStatus.textContent = data.details.deviceInfo || 'Unknown';
  dateTimeStatus.textContent = data.details.dateTime || 'Unknown';
  otherMetadataStatus.textContent = data.details.otherMetadata || 'Unknown';
  if (annotationsValue) annotationsValue.textContent = data.metadata.annotations || 'Unknown';
  if (formFieldsValue) formFieldsValue.textContent = data.metadata.formFields || 'Unknown';
  if (hiddenLayersValue) hiddenLayersValue.textContent = data.metadata.hiddenLayers || 'Unknown';
};

const getFileExtension = (name) => {
  const m = (name || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '';
};

const isAllowedFileType = (file) => {
  const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.pdf', '.docx', '.pptx', '.xlsx'];
  const allowedMimePrefixes = ['image/', 'video/', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  const ext = getFileExtension(file.name || '');
  if (allowedExts.includes(ext)) return true;
  if (file.type) {
    for (const p of allowedMimePrefixes) if (file.type.startsWith(p) || file.type === p) return true;
  }
  return false;
};

const supportsOfflineClean = (file) => {
  if (!file) return false;
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const ext = getFileExtension(file.name || '');
  return imageExts.includes(ext) || file.type?.startsWith('image/');
};

const getGranularOptions = () => {
  return {
    removeGPS: removeGPS?.checked ?? true,
    removeDevice: removeDevice?.checked ?? true,
    removeDateTime: removeDateTime?.checked ?? true,
    removeAuthor: removeAuthor?.checked ?? true,
    removeAnnotations: removeAnnotations?.checked ?? true,
    enableBlur: enableBlur?.checked ?? false
  };
};

const updateServerStatusBadge = (available) => {
  if (!serverStatusBadge) return;
  serverStatusBadge.classList.toggle('online', available);
  serverStatusBadge.classList.toggle('offline', !available);
  serverStatusBadge.textContent = available ? 'Server: Online' : 'Server: Offline';
  serverStatusBadge.title = available ? 'Local server is available' : 'Server unavailable; only offline image cleanup works';
};

const setActionButtonState = () => {
  const canServer = !!apiBase || isHttpUrl || serverAvailable;
  const canClean = canServer || supportsOfflineClean(currentFile) || fileQueue.some(supportsOfflineClean);
  if (cleanButton) cleanButton.disabled = !canClean;
  if (downloadCleanButton) downloadCleanButton.disabled = !cleanedFileUrl;
  updateServerStatusBadge(canServer);
  if (cleanButton && cleanButton.disabled) {
    if (!canServer && currentFile && !supportsOfflineClean(currentFile)) {
      const fileType = currentFile.type || 'file';
      cleanButton.title = `Cleaning ${fileType.includes('video') ? 'videos' : fileType.includes('pdf') ? 'PDFs' : 'this file type'} requires the local server. Start the server: node server.js`;
    } else {
      cleanButton.title = 'Cleaning requires the local server; run: node server.js then open http://localhost:3000';
    }
  } else if (cleanButton) {
    cleanButton.title = 'Clean the current file now';
  }
  if (downloadCleanButton && downloadCleanButton.disabled) {
    downloadCleanButton.title = 'Download becomes available after cleaning a file.';
  } else if (downloadCleanButton) {
    downloadCleanButton.title = 'Download the cleaned file';
  }
};

const uploadFileToServer = (file) => new Promise((resolve, reject) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('options', JSON.stringify(getGranularOptions()));
  try { if (uploadStatus) uploadStatus.textContent = ''; } catch (e) {}
  const url = getApiBaseUrl('/api/upload');

  // Use XHR when possible so we can report upload progress; fall back to fetch
  if (window.XMLHttpRequest && uploadProgress) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && uploadProgress) {
        const pct = Math.round((e.loaded / e.total) * 100);
        uploadProgress.style.width = pct + '%';
        uploadProgress.textContent = pct + '%';
      }
    };

    xhr.onload = () => {
      xhrUpload = null;
      if (cancelUploadBtn) cancelUploadBtn.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(null); }
      } else {
        let err = { error: xhr.statusText };
        try { err = JSON.parse(xhr.responseText); } catch (e) {}
        reject(new Error(err.error || `Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => { xhrUpload = null; if (cancelUploadBtn) cancelUploadBtn.style.display = 'none'; reject(new Error('Network error')); };
    xhr.onabort = () => { xhrUpload = null; if (cancelUploadBtn) cancelUploadBtn.style.display = 'none'; reject(new Error('Upload canceled')); };

    xhrUpload = xhr;
    if (cancelUploadBtn) cancelUploadBtn.style.display = 'inline-flex';
    try { xhr.send(formData); } catch (e) { reject(e); }
    return;
  }

  // Fallback: simple fetch without progress
  (async () => {
    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Upload failed (${res.status})`);
      }
      const json = await res.json();
      resolve(json);
    } catch (err) {
      reject(err);
    }
  })();
});

const cleanFileOffline = async (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      URL.revokeObjectURL(url);
      return reject(new Error('Unable to create canvas context')); }
    ctx.drawImage(img, 0, 0);
    const outputType = file.type || 'image/png';
    const quality = outputType === 'image/jpeg' ? 0.95 : undefined;
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(url);
      if (!blob) return reject(new Error('Unable to generate cleaned image'));
      resolve(blob);
    }, outputType, quality);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('Unable to load image for offline cleaning'));
  };
  img.src = url;
});

const cleanFileOnServer = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('options', JSON.stringify(getGranularOptions()));

  const response = await fetch(getApiBaseUrl('/api/clean'), {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || 'Failed to clean file on server');
  }

  cleanedFilesCount++;
  if (cleanedCount) cleanedCount.textContent = cleanedFilesCount;

  return response.blob();
};

const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB to match backend upload limits

const handleFile = async (file) => {
  // client-side validation: size and type
  const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.pdf', '.docx', '.pptx', '.xlsx'];
  const allowedMimePrefixes = ['image/', 'video/', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  const getExt = (name) => {
    const m = name.toLowerCase().match(/(\.[a-z0-9]+)$/);
    return m ? m[1] : '';
  };
  const isAllowed = (file) => {
    const ext = getExt(file.name || '');
    if (allowedExts.includes(ext)) return true;
    if (file.type) {
      for (const p of allowedMimePrefixes) if (file.type.startsWith(p) || file.type === p) return true;
    }
    return false;
  };

  if (!isAllowed(file)) {
    if (uploadStatus) uploadStatus.textContent = 'Unsupported file type. Supported: JPG, PNG, MP4, PDF, DOCX, PPTX, XLSX.';
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    if (uploadStatus) uploadStatus.textContent = `File too large. Maximum ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB.`;
    return;
  }

  currentFile = file;
  setActionButtonState();
  imageCaption.textContent = `${file.name} ready for scan`;
  const reader = new FileReader();
  reader.onload = (event) => setPreview(file, event.target.result);
  reader.readAsDataURL(file);

  riskScore.textContent = '--';
  riskLabel.textContent = 'Scanning...';
  riskSummaryText.textContent = 'Scanning file for metadata...';

  // reset progress
  if (uploadProgress) { uploadProgress.style.width = '0%'; uploadProgress.textContent = '0%'; }

  try {
    let data;
    if (uploadStatus) uploadStatus.textContent = 'Scanning file...';
    // If an API endpoint is configured, prefer server-side scan/clean even when running from file://
    if (!apiBase && isLocalFile) {
      data = await scanFileOffline(file);
      if (uploadStatus) uploadStatus.textContent = 'Offline scan complete. Some metadata values may be limited.';
      updateMetadataUI(data);
      setScanSource('offline');
    } else {
      try {
        if (uploadStatus) uploadStatus.textContent = 'Scanning file on server...';
        data = await uploadFileToServer(file);
        updateMetadataUI(data);
        setScanSource('server');
        if (uploadStatus) uploadStatus.textContent = 'Server scan complete.';
      } catch (srvErr) {
        // server upload failed -> fallback to offline scan and show badge
        console.warn('Server scan failed, falling back to offline scan', srvErr);
        if (uploadStatus) uploadStatus.textContent = 'Server scan failed — performing offline fallback.';
        data = await scanFileOffline(file);
        updateMetadataUI(data);
        setScanSource('offline');
      }
    }
  } catch (error) {
    console.error(error);
    if (uploadStatus) uploadStatus.textContent = error.message || 'Upload error';
    // If server upload failed, automatically attempt a limited offline scan as a fallback
    try {
      const fallback = await scanFileOffline(file);
      updateMetadataUI(fallback);
      if (uploadStatus) uploadStatus.textContent = 'Server upload failed — performed limited offline scan.';
    } catch (fbErr) {
      console.warn('Offline fallback failed', fbErr);
    }
  }
};

fileInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) {
    handleFile(file).finally(() => {
      fileInput.value = '';
    });
  }
});

folderInput.addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length > 0) {
    fileQueue = files.filter(f => isAllowedFileType(f));
    if (fileQueue.length > 0) {
      batchQueue.style.display = 'block';
      queueCount.textContent = fileQueue.length;
      uploadStatus.textContent = `📦 Queued ${fileQueue.length} files for batch processing. Click "Clean File Now" to start.`;
      if (uploadStatus) uploadStatus.textContent = `📦 Added ${fileQueue.length} files to batch queue.`;
      setActionButtonState();
    } else {
      uploadStatus.textContent = 'No supported files found in folder.';
    }
  }
});

openImageBtn.addEventListener('click', () => {
  fileInput.click();
});

rescanButton.addEventListener('click', () => {
  if (currentFile) {
    handleFile(currentFile);
  }
});

cleanButton.addEventListener('click', async () => {
  if (!currentFile && fileQueue.length === 0) return;

  // Handle batch processing if queue exists
  if (fileQueue.length > 0) {
    isProcessingBatch = true;
    uploadStatus.textContent = `🔄 Processing batch: 1/${fileQueue.length}...`;
    
    for (let i = 0; i < fileQueue.length; i++) {
      try {
        const file = fileQueue[i];
        uploadStatus.textContent = `🔄 Cleaning ${i + 1}/${fileQueue.length}: ${file.name}...`;
        let cleanBlob;
        if (!apiBase && supportsOfflineClean(file)) {
          cleanBlob = await cleanFileOffline(file);
        } else if (apiBase) {
          cleanBlob = await cleanFileOnServer(file);
        } else {
          throw new Error('This file type requires the local server to clean.');
        }
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(cleanBlob);
        link.download = `cleaned-${file.name}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (error) {
        console.error(`Batch error on file ${fileQueue[i].name}:`, error);
        uploadStatus.textContent = `⚠️ Error on file ${fileQueue[i].name}: ${error.message || 'Clean failed'}`;
      }
    }
    
    fileQueue = [];
    batchQueue.style.display = 'none';
    uploadStatus.textContent = `✅ Batch complete! ${cleanedFilesCount} files cleaned.`;
    isProcessingBatch = false;
    setActionButtonState();
    return;
  }

  // Single file processing
  if (!currentFile) return;

  try {
    let cleanBlob;
    if (!apiBase && supportsOfflineClean(currentFile)) {
      cleanBlob = await cleanFileOffline(currentFile);
    } else if (apiBase) {
      cleanBlob = await cleanFileOnServer(currentFile);
    } else {
      if (uploadStatus) uploadStatus.textContent = 'This file type requires the local server to clean.';
      return;
    }

    const url = URL.createObjectURL(cleanBlob);
    cleanedFileUrl = url;
    setCleanPreview(currentFile, url);
    if (uploadStatus) uploadStatus.textContent = 'Clean complete.';
    cleanedFilesCount++;
    if (cleanedCount) cleanedCount.textContent = cleanedFilesCount;
    setActionButtonState();
  } catch (error) {
    console.error(error);
    if (uploadStatus) uploadStatus.textContent = error?.message || 'Failed to clean file.';
  }
});

downloadCleanButton.addEventListener('click', () => {
  if (!cleanedFileUrl) {
    if (uploadStatus) uploadStatus.textContent = 'No cleaned file available yet. Please clean a file first.';
    return;
  }

  const link = document.createElement('a');
  link.href = cleanedFileUrl;
  link.download = `cleaned-${currentFile?.name || 'image'}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

['dragenter', 'dragover'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
});

dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (file) {
    handleFile(file);
  }
});

if (cancelUploadBtn) {
  cancelUploadBtn.addEventListener('click', () => {
    if (xhrUpload) {
      try { xhrUpload.abort(); } catch (e) {}
      if (uploadStatus) uploadStatus.textContent = 'Upload canceled.';
      if (uploadProgress) { uploadProgress.style.width = '0%'; uploadProgress.textContent = '0%'; }
      xhrUpload = null;
      cancelUploadBtn.style.display = 'none';
    }
  });
}

// Accessibility & mobile: make drop zone clickable and keyboard operable
if (dropZone) {
  dropZone.addEventListener('click', (e) => {
    // The file input covers the drop zone. Avoid dispatching a second click event when the input is the target.
    if (e.target === fileInput) return;
    if (fileInput) fileInput.click();
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (fileInput) fileInput.click();
    }
  });

  // touch visual feedback
  dropZone.addEventListener('touchstart', () => dropZone.classList.add('touch-active'));
  dropZone.addEventListener('touchend', () => dropZone.classList.remove('touch-active'));
}

// UI: tips and history elements
const tipsList = document.getElementById('tipsList');
const historyLog = document.getElementById('historyLog');

// Simple SPA navigation between sections
const navLinks = document.querySelectorAll('.nav-links a');
const sections = document.querySelectorAll('.page-section');

const showSection = (id) => {
  sections.forEach((s) => {
    if (s.id === id) s.style.display = 'block'; else s.style.display = 'none';
  });
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.target === id));
};

const fetchTips = async () => {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/tips`);
    if (!res.ok) return;
    const data = await res.json();
    tipsList.innerHTML = '';
    (data.tips || []).forEach((t) => {
      const el = document.createElement('div');
      el.className = 'tip-card';
      el.innerHTML = `<h4>${t.title}</h4><p>${t.description}</p>`;
      tipsList.appendChild(el);
    });
  } catch (err) {
    console.warn('Failed to load tips', err);
  }
};

const fetchHistory = async () => {
  if (!apiBase) return;
  try {
    const res = await fetch(`${apiBase}/api/history`);
    if (!res.ok) return;
    const data = await res.json();
    historyLog.innerHTML = '';
    const history = data.history || [];
    if (!history.length) {
      historyLog.innerHTML = '<div class="history-empty">No scans yet. Your recent uploads will appear here.</div>';
      return;
    }
    
    // Update stats
    updateHistoryStats(history);
    
    history.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.innerHTML = `<div><strong>${item.fileName}</strong><div class="muted">${new Date(item.time).toLocaleString()}</div></div><div>${item.risk} • ${item.fileSize}</div>`;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      // attach click/keyboard handler to load history item details into UI
      const loadItem = () => {
        // populate metadata-like fields from available history info
        imageCaption.textContent = `${item.fileName} (from history)`;
        fileSizeValue.textContent = item.fileSize || 'Unknown';
        riskScore.textContent = '--';
        riskLabel.textContent = item.risk || 'Unknown';
        locationDataStatus.textContent = item.gpsLocation || 'N/A';
        // scroll to top of main content
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      row.addEventListener('click', loadItem);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadItem(); } });
      historyLog.appendChild(row);
    });
  } catch (err) {
    console.warn('Failed to load history', err);
  }
};

const updateHistoryStats = (history) => {
  const total = history.length;
  const highRisk = history.filter(item => item.risk === 'High Risk').length;
  
  if (totalScans) totalScans.textContent = total;
  if (highRiskCount) highRiskCount.textContent = highRisk;
  if (cleanedCount) cleanedCount.textContent = cleanedFilesCount;
};

const downloadReportAsJSON = () => {
  try {
    const report = {
      generatedAt: new Date().toISOString(),
      totalScans: totalScans.textContent,
      highRiskFiles: highRiskCount.textContent,
      cleanedFiles: cleanedFilesCount,
      adviceLinks: [
        'Remove location data from all photos',
        'Disable location tagging in social media settings',
        'Clean documents before professional sharing',
        'Use MetaGuard before uploading to any platform'
      ]
    };
    
    const dataStr = JSON.stringify(report, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `metaguard-report-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Report export error:', error);
  }
};

if (exportReport) {
  exportReport.addEventListener('click', downloadReportAsJSON);
}

navLinks.forEach((a) => {
  const href = a.getAttribute('href');
  if (href === '#' || href?.startsWith('index.html')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = a.dataset.target || 'privacy';
      showSection(target);
    });
  }
});

// Initialize UI on load
window.addEventListener('DOMContentLoaded', async () => {
  // show default dashboard section
  showSection('privacy');
  await detectLocalServer();
  setActionButtonState();

  if (!isLocalFile || apiBase) {
    fetchTips();
    fetchHistory();
    try { checkServerAvailability(); } catch (e) {}
  }

  // Apply persisted theme preference
  try {
    const saved = localStorage.getItem('meta_theme');
    applyTheme(saved || 'dark');
  } catch (e) {}

  // Poll for local server every 2 seconds if running from file:// without a server
  if (isLocalFile && !apiBase) {
    const serverPoll = setInterval(async () => {
      const found = await detectLocalServer();
      if (found) {
        clearInterval(serverPoll);
        fetchTips();
        fetchHistory();
      }
    }, 2000);
  }
});

const showServerNotice = (show = true, reason = '') => {
  try {
    if (!serverNotice) return;
    const dismissed = localStorage.getItem('dismissServerNotice');
    if (dismissed) return;
    serverNotice.style.display = show ? 'flex' : 'none';
    const text = document.getElementById('serverNoticeText');
    const sub = document.getElementById('serverNoticeSub');
    if (text && reason) text.textContent = reason;
    if (sub) sub.style.display = show ? 'inline' : 'none';
  } catch (e) {}
};

startServerBtn?.addEventListener('click', () => {
  window.open('http://localhost:3000', '_blank');
});

dismissServerNotice?.addEventListener('click', () => {
  try { localStorage.setItem('dismissServerNotice', '1'); } catch (e) {}
  showServerNotice(false);
});

window.addEventListener('online', async () => {
  serverAvailable = false;
  if (isLocalFile || apiBase || isHttpUrl) {
    await checkServerAvailability();
  }
});

window.addEventListener('offline', () => {
  serverAvailable = false;
  showServerNotice(true, 'Network offline');
  setActionButtonState();
});

// API base is set via console helper `window.setMetaApiBase(url)` (kept off-screen)

const checkServerAvailability = async () => {
  const url = getApiBaseUrl('/api/tips');
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      serverAvailable = false;
      showServerNotice(true, 'Server not responding');
    } else {
      serverAvailable = true;
      if (!apiBase && !isHttpUrl) apiBase = DEFAULT_LOCAL_API_BASE;
      setActionButtonState();
      showServerNotice(false);
    }
  } catch (err) {
    serverAvailable = false;
    showServerNotice(true, 'Server not reachable');
  }
};

const applyTheme = (theme) => {
  const isLight = theme === 'light';
  try { document.body.classList.toggle('light-theme', isLight); } catch (e) {}
  try { document.documentElement.classList.toggle('light-theme', isLight); } catch (e) {}
  if (themeToggle) {
    themeToggle.setAttribute('aria-pressed', String(isLight));
    themeToggle.textContent = isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode';
    themeToggle.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
  }
  try { localStorage.setItem('meta_theme', theme); } catch (e) {}
};

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.body.classList.contains('light-theme') ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
  });
}
