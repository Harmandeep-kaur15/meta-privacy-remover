const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
try {
  ffmpeg.setFfmpegPath(require('ffmpeg-static'));
  ffmpeg.setFfprobePath(require('ffprobe-static').path);
} catch (err) {
  console.warn('ffmpeg not available via ffmpeg-static:', err.message);
}
const { PDFDocument, PDFName, PDFDict, PDFArray } = require('pdf-lib');
const JSZip = require('jszip');
const cors = require('cors');
const multer = require('multer');
const ExifParser = require('exif-parser');
const sharp = require('sharp');

const app = express();
// --- Logging: write access logs to access.log in project root ---
try {
  const accessLogStream = fs.createWriteStream(path.join(__dirname, 'access.log'), { flags: 'a' });
  app.use(morgan('combined', { stream: accessLogStream }));
} catch (err) {
  console.warn('Could not create access.log stream:', err.message);
}

// --- Rate limiting for API routes ---
try {
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 120, // limit each IP to 120 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api/', apiLimiter);
} catch (err) {
  console.warn('Rate limiter unavailable:', err.message);
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

app.use(cors());
app.use(express.static(path.join(__dirname)));

const formatBytes = (bytes) => {
  if (!bytes) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
};

const buildGpsString = (latitude, longitude) => {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return 'Unknown';
  const latCardinal = latitude >= 0 ? 'N' : 'S';
  const lngCardinal = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(4)}° ${latCardinal}, ${Math.abs(longitude).toFixed(4)}° ${lngCardinal}`;
};

let scanHistory = [];
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Load persisted history if available
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    scanHistory = JSON.parse(content) || [];
  }
} catch (err) {
  console.warn('Could not load history file:', err.message);
}

const saveHistory = () => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(scanHistory.slice(0, 100), null, 2));
  } catch (err) {
    console.error('Failed to save history:', err.message);
  }
};

const getXmlTagValue = (xml, tag) => {
  const match = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`).exec(xml);
  return match ? match[1].trim() : undefined;
};

const parseOfficeMetadata = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const result = {
    title: 'Unknown',
    author: 'Unknown',
    created: 'Unknown',
    modified: 'Unknown',
    pages: 'Unknown',
    metadataFound: false,
  };

  const coreFile = zip.file('docProps/core.xml');
  if (coreFile) {
    const xml = await coreFile.async('text');
    result.title = getXmlTagValue(xml, 'dc:title') || result.title;
    result.author = getXmlTagValue(xml, 'dc:creator') || result.author;
    result.created = getXmlTagValue(xml, 'dcterms:created') || result.created;
    result.modified = getXmlTagValue(xml, 'dcterms:modified') || result.modified;
    result.metadataFound = true;
  }

  const appFile = zip.file('docProps/app.xml');
  if (appFile) {
    const xml = await appFile.async('text');
    result.pages = getXmlTagValue(xml, 'Pages') || result.pages;
    result.metadataFound = true;
  }

  return result;
};

const cleanOfficeDocument = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const output = new JSZip();

  await Promise.all(Object.values(zip.files).map(async (file) => {
    if (file.name.startsWith('docProps/')) return;
    output.file(file.name, await file.async('nodebuffer'));
  }));

  return output.generateAsync({ type: 'nodebuffer' });
};

const calculateRisk = (tags) => {
  const score = [
    tags.GPSLatitude && tags.GPSLongitude ? 30 : 0,
    tags.DateTimeOriginal || tags.CreateDate ? 20 : 0,
    tags.Make || tags.Model ? 20 : 0,
    Object.keys(tags).length > 5 ? 20 : 0,
  ].reduce((sum, value) => sum + value, 0);

  if (score >= 60) return { level: 'High Risk', score: 75 };
  if (score >= 35) return { level: 'Medium Risk', score: 50 };
  return { level: 'Low Risk', score: 20 };
};

const safeParseExif = (buffer) => {
  try {
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    return result.tags || {};
  } catch (err) {
    return {};
  }
};

const getNormalizedMimeType = (mime, ext) => {
  const extensionMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mime || extensionMap[ext] || 'application/octet-stream';
};

app.get('/api/history', (req, res) => {
  return res.json({ history: scanHistory.slice(0, 10) });
});

app.get('/api/tips', (req, res) => {
  return res.json({
    tips: [
      { title: 'Remove location data', description: 'GPS coordinates in photo metadata can reveal where you live, work, or travel.' },
      { title: 'Don’t share device details', description: 'Camera make and model can expose the exact hardware and software used to capture the image.' },
      { title: 'Strip timestamps before posting', description: 'Time metadata makes it easy to reconstruct your routines or schedule.' },
      { title: 'Keep hidden metadata private', description: 'Metadata often includes thumbnails, editing history, and file source details.' },
      { title: 'Use a secure cleaner', description: 'Clean metadata locally to avoid uploading private images to unknown services.' },
    ],
  });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  let options = {};
  try {
    options = req.body.options ? JSON.parse(req.body.options) : {};
  } catch (err) {
    options = {};
  }

  try {
    const mime = req.file.mimetype || '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    const normalizedMime = getNormalizedMimeType(mime, ext);
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    const documentExts = ['.docx', '.pptx', '.xlsx'];

    // Image path (existing behavior)
    if (normalizedMime.startsWith('image/') || imageExts.includes(ext)) {
      const image = sharp(req.file.buffer);
      const metadata = await image.metadata();
      const tags = safeParseExif(req.file.buffer);

      const response = {
        type: 'image',
        fileName: req.file.originalname,
        fileSize: formatBytes(req.file.size),
        metadata: {
          cameraModel: tags.Model || tags.Make || 'Unknown',
          dateTime: tags.DateTimeOriginal || tags.CreateDate || tags.ModifyDate || 'Unknown',
          gpsLocation: buildGpsString(tags.GPSLatitude, tags.GPSLongitude),
          device: tags.Model && tags.Make ? `${tags.Make} ${tags.Model}` : tags.Model || tags.Make || 'Unknown',
          aperture: tags.FNumber ? `f/${tags.FNumber}` : 'Unknown',
          focalLength: tags.FocalLength ? `${tags.FocalLength} mm` : 'Unknown',
          iso: tags.ISO || tags.ISOSpeedRatings || 'Unknown',
          dimensions: metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : 'Unknown',
        },
        risk: calculateRisk(tags),
        details: {
          locationData: tags.GPSLatitude && tags.GPSLongitude ? 'Found' : 'Not found',
          deviceInfo: tags.Make || tags.Model ? 'Found' : 'Not found',
          dateTime: tags.DateTimeOriginal || tags.CreateDate ? 'Found' : 'Not found',
          otherMetadata: Object.keys(tags).length > 0 ? 'Found' : 'No metadata',
        },
      };

      scanHistory.unshift({
        time: new Date().toISOString(),
        fileName: req.file.originalname,
        fileSize: response.fileSize,
        risk: response.risk.level,
        gpsLocation: response.metadata.gpsLocation,
      });

      saveHistory();
      return res.json(response);
    }

    // Video handling: write to temp file and probe tags
    if (normalizedMime.startsWith('video/') || videoExts.includes(ext)) {
      const tmpIn = path.join(os.tmpdir(), `upload-${Date.now()}${ext || '.mp4'}`);
      fs.writeFileSync(tmpIn, req.file.buffer);

      const ffprobe = () => new Promise((resolve, reject) => {
        ffmpeg.ffprobe(tmpIn, (err, info) => (err ? reject(err) : resolve(info)));
      });

      try {
        const info = await ffprobe();
        const tags = (info.format && info.format.tags) || {};
        const response = {
          type: 'video',
          fileName: req.file.originalname,
          fileSize: formatBytes(req.file.size),
          metadata: {
            format: info.format.format_name || 'Unknown',
            duration: info.format.duration ? `${Math.round(info.format.duration)}s` : 'Unknown',
            bitrate: info.format.bit_rate ? `${Math.round(info.format.bit_rate/1000)} kbps` : 'Unknown',
            tags: tags,
          },
          risk: { level: tags.location || tags.location ? 'Medium Risk' : 'Low Risk', score: tags.location ? 50 : 20 },
          details: {
            locationData: tags.location ? 'Found' : 'Not found',
            deviceInfo: tags.vendor || tags.encoder ? 'Found' : 'Not found',
            dateTime: tags.creation_time || 'Not found',
            otherMetadata: Object.keys(tags).length > 0 ? 'Found' : 'No metadata',
          },
        };

        // cleanup tmpIn
        try { fs.unlinkSync(tmpIn); } catch (e) {}

        scanHistory.unshift({
          time: new Date().toISOString(),
          fileName: req.file.originalname,
          fileSize: response.fileSize,
          risk: response.risk.level,
          gpsLocation: response.metadata.tags && (response.metadata.tags.location || 'Unknown'),
        });
        saveHistory();
        return res.json(response);
      } catch (err) {
        try { fs.unlinkSync(tmpIn); } catch (e) {}
        console.error('Video probe error', err);
        return res.status(500).json({ error: 'Unable to parse video metadata.' });
      }
    }

    // Office document handling
    if (documentExts.includes(ext) ||
        normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        normalizedMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      try {
        const documentMeta = await parseOfficeMetadata(req.file.buffer);
        const response = {
          type: 'document',
          fileName: req.file.originalname,
          fileSize: formatBytes(req.file.size),
          metadata: {
            title: documentMeta.title,
            author: documentMeta.author,
            created: documentMeta.created,
            modified: documentMeta.modified,
            pages: documentMeta.pages,
          },
          risk: { level: documentMeta.metadataFound ? 'Medium Risk' : 'Low Risk', score: documentMeta.metadataFound ? 50 : 20 },
          details: {
            locationData: 'Not applicable',
            deviceInfo: 'Not applicable',
            dateTime: documentMeta.created !== 'Unknown' || documentMeta.modified !== 'Unknown' ? 'Found' : 'Not found',
            otherMetadata: documentMeta.metadataFound ? 'Found' : 'No metadata',
          },
        };

        scanHistory.unshift({
          time: new Date().toISOString(),
          fileName: req.file.originalname,
          fileSize: response.fileSize,
          risk: response.risk.level,
          gpsLocation: 'N/A',
        });
        saveHistory();

        return res.json(response);
      } catch (err) {
        console.error('Document parse error', err);
        return res.status(500).json({ error: 'Unable to parse document metadata.' });
      }
    }

    // PDF handling
    if (normalizedMime === 'application/pdf' || ext === '.pdf') {
      try {
        const src = await PDFDocument.load(req.file.buffer);
        const pageCount = src.getPageCount();
        const pages = src.getPages();
        const catalog = src.context.lookup(src.context.trailerInfo.Root, PDFDict);

        const hasAnnotations = pages.some((page) => Boolean(page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)));
        const hasAcroForm = Boolean(catalog && catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict));
        const hasMetadataStream = Boolean(catalog && catalog.lookupMaybe(PDFName.of('Metadata'), PDFDict));
        const hasJavaScript = Boolean(catalog && catalog.lookupMaybe(PDFName.of('Names'), PDFDict) && catalog.lookupMaybe(PDFName.of('Names'), PDFDict).lookupMaybe(PDFName.of('JavaScript'), PDFDict));
        const hasOpenAction = Boolean(catalog && catalog.lookupMaybe(PDFName.of('OpenAction')));
        const hasOCProperties = Boolean(catalog && catalog.lookupMaybe(PDFName.of('OCProperties')));

        const riskScore = [
          hasAnnotations ? 20 : 0,
          hasAcroForm ? 20 : 0,
          hasMetadataStream ? 15 : 0,
          hasJavaScript ? 25 : 0,
          hasOpenAction ? 10 : 0,
          hasOCProperties ? 10 : 0,
        ].reduce((sum, value) => sum + value, 0);

        const risk = riskScore >= 50 ? { level: 'High Risk', score: Math.min(90, riskScore) }
          : riskScore >= 20 ? { level: 'Medium Risk', score: Math.max(35, riskScore) }
          : { level: 'Low Risk', score: Math.max(10, riskScore) };

        const response = {
          type: 'pdf',
          fileName: req.file.originalname,
          fileSize: formatBytes(req.file.size),
          metadata: {
            pages: pageCount,
            annotations: hasAnnotations ? 'Found' : 'None',
            formFields: hasAcroForm ? 'Found' : 'None',
            hiddenLayers: hasOCProperties ? 'Found' : 'None',
          },
          risk,
          details: {
            locationData: 'Not applicable',
            deviceInfo: 'Not applicable',
            dateTime: 'Not applicable',
            otherMetadata: hasMetadataStream || hasJavaScript || hasOpenAction ? 'Found' : 'No hidden metadata',
          },
        };

        scanHistory.unshift({
          time: new Date().toISOString(),
          fileName: req.file.originalname,
          fileSize: response.fileSize,
          risk: response.risk.level,
          gpsLocation: 'N/A',
        });
        saveHistory();

        return res.json(response);
      } catch (err) {
        console.error('PDF parse error', err);
        return res.status(500).json({ error: 'Unable to parse PDF.' });
      }
    }

    // Fallback: unsupported file types
    return res.status(400).json({ error: 'Unsupported file type for metadata scanning.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to parse image metadata.' });
  }
});

app.post('/api/clean', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const mime = req.file.mimetype || '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    const normalizedMime = getNormalizedMimeType(mime, ext);
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    const documentExts = ['.docx', '.pptx', '.xlsx'];

    // Images: reuse previous approach
    if (normalizedMime.startsWith('image/') || imageExts.includes(ext)) {
      const image = sharp(req.file.buffer);
      const metadata = await image.metadata();
      const extension = metadata.format || path.extname(req.file.originalname).slice(1) || 'jpeg';
      let cleaned;
      // Options may request keeping metadata; default is to remove common metadata
      let options = {};
      try { options = req.body.options ? JSON.parse(req.body.options) : {}; } catch (e) { options = (typeof req.body.options === 'object' && req.body.options) ? req.body.options : {}; }
      const removeGPS = options.removeGPS !== false;
      const removeDevice = options.removeDevice !== false;
      const removeDateTime = options.removeDateTime !== false;
      const removeAuthor = options.removeAuthor !== false;

      const needsStrip = removeGPS || removeDevice || removeDateTime || removeAuthor;

      if (!needsStrip) {
        // return original file unchanged if user opted to keep metadata
        res.type(req.file.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="cleaned-${req.file.originalname}"`);
        return res.send(req.file.buffer);
      }

      // prefer preserving original format; increase quality for cleaned images
      if (extension === 'png') {
        // reduce compression to preserve visual quality
        cleaned = await image.png({ compressionLevel: 0 }).toBuffer();
        res.type('image/png');
      } else {
        // for JPEG outputs, use high quality and disable chroma subsampling to keep color fidelity
        cleaned = await image.jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
        res.type('image/jpeg');
      }

      res.setHeader('Content-Disposition', `attachment; filename="cleaned-${req.file.originalname}"`);
      return res.send(cleaned);
    }

    // Videos: use ffmpeg to strip metadata
    if (normalizedMime.startsWith('video/') || videoExts.includes(ext)) {
      const tmpIn = path.join(os.tmpdir(), `upload-${Date.now()}${ext || '.mp4'}`);
      const tmpOut = path.join(os.tmpdir(), `cleaned-${Date.now()}${ext || '.mp4'}`);
      fs.writeFileSync(tmpIn, req.file.buffer);

      try {
        await new Promise((resolve, reject) => {
          ffmpeg(tmpIn)
            .outputOptions(['-map_metadata', '-1', '-c', 'copy'])
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(tmpOut);
        });

        const outBuffer = fs.readFileSync(tmpOut);
        res.type(req.file.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="cleaned-${req.file.originalname}"`);

        // cleanup
        try { fs.unlinkSync(tmpIn); } catch (e) {}
        try { fs.unlinkSync(tmpOut); } catch (e) {}

        return res.send(outBuffer);
      } catch (err) {
        try { fs.unlinkSync(tmpIn); } catch (e) {}
        try { fs.unlinkSync(tmpOut); } catch (e) {}
        console.error('Video clean error', err);
        return res.status(500).json({ error: 'Unable to clean video metadata. Ensure ffmpeg is available.' });
      }
    }

    // Office documents: strip document metadata files
    if (documentExts.includes(ext) ||
        normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        normalizedMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      try {
        let options = {};
        try { options = req.body.options ? JSON.parse(req.body.options) : {}; } catch (e) { options = (typeof req.body.options === 'object' && req.body.options) ? req.body.options : {}; }
        const removeGPS = options.removeGPS !== false;
        const removeDevice = options.removeDevice !== false;
        const removeDateTime = options.removeDateTime !== false;
        const removeAuthor = options.removeAuthor !== false;

        let cleanedBytes;
        const needsStrip = removeGPS || removeDevice || removeDateTime || removeAuthor;
        if (needsStrip) {
          cleanedBytes = await cleanOfficeDocument(req.file.buffer);
        } else {
          cleanedBytes = req.file.buffer;
        }
        res.type(req.file.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="cleaned-${req.file.originalname}"`);
        return res.send(cleanedBytes);
      } catch (err) {
        console.error('Document clean error', err);
        return res.status(500).json({ error: 'Unable to clean document metadata.' });
      }
    }

    // PDFs: deep sanitize metadata, hidden objects, annotations, and JPEG image EXIF
    if (normalizedMime === 'application/pdf' || ext === '.pdf') {
      let options = {};
      try {
        options = req.body.options ? JSON.parse(req.body.options) : {};
      } catch (e) {
        options = (typeof req.body.options === 'object' && req.body.options) ? req.body.options : {};
      }
      const removeAnnotations = options.removeAnnotations !== false;
      const removeGPS = options.removeGPS !== false;
      const removeDevice = options.removeDevice !== false;
      const removeDateTime = options.removeDateTime !== false;
      const removeAuthor = options.removeAuthor !== false;
      const enableBlur = options.enableBlur === true;
      try {
        const src = await PDFDocument.load(req.file.buffer);

        const removePdfInfo = () => {
          // Conditionally remove specific Info keys based on options
          const info = src.context.trailerInfo.Info;
          if (info && info instanceof Object) {
            try {
              const keysToRemove = [];
              if (removeAuthor) keysToRemove.push('Author', 'Creator');
              if (removeDevice) keysToRemove.push('Producer');
              if (removeDateTime) keysToRemove.push('CreationDate', 'ModDate');
              // always remove title/keywords when any removal is requested
              if (removeAuthor || removeDateTime || removeDevice || removeGPS) keysToRemove.push('Title', 'Keywords');

              // Attempt to delete keys from the Info object
              keysToRemove.forEach((k) => {
                if (info[k]) delete info[k];
              });
            } catch (e) {
              // fallback: remove whole Info dictionary
              try { delete src.context.trailerInfo.Info; } catch (e) {}
            }
          }

          const catalog = src.context.lookup(src.context.trailerInfo.Root, PDFDict);
          if (catalog instanceof PDFDict) {
            if (removeAuthor || removeDateTime || removeDevice || removeGPS) {
              catalog.delete(PDFName.of('Metadata'));
              catalog.delete(PDFName.of('OpenAction'));
              catalog.delete(PDFName.of('AA'));
              catalog.delete(PDFName.of('OCProperties'));
            }

            const names = catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
            if (names instanceof PDFDict) {
              names.delete(PDFName.of('JavaScript'));
              if (names.size() === 0) {
                catalog.delete(PDFName.of('Names'));
              }
            }
          }
        };

        const flattenAndRemoveAnnotations = () => {
          try {
            if (removeAnnotations) {
              const form = src.getForm();
              const fields = form.getFields();
              if (fields.length > 0) {
                form.flatten();
              }
            }
          } catch (e) {
            // Ignore if form flattening fails or no form exists.
          }

          const pages = src.getPages();
          pages.forEach((page) => {
            const pageNode = page.node;
            if (removeAnnotations) {
              pageNode.delete(PDFName.of('Annots'));
            }
            pageNode.delete(PDFName.of('PieceInfo'));
            pageNode.delete(PDFName.of('Metadata'));
            pageNode.delete(PDFName.of('LastModified'));
          });

          const catalog = src.context.lookup(src.context.trailerInfo.Root, PDFDict);
          if (catalog instanceof PDFDict && removeAnnotations) {
            catalog.delete(PDFName.of('AcroForm'));
          }
        };

        const isDctDecode = (filterObject) => {
          if (filterObject instanceof PDFName) {
            return filterObject === PDFName.of('DCTDecode');
          }
          if (filterObject instanceof PDFArray) {
            for (let idx = 0, len = filterObject.size(); idx < len; idx++) {
              const item = filterObject.get(idx);
              if (item instanceof PDFName && item === PDFName.of('DCTDecode')) {
                return true;
              }
            }
          }
          return false;
        };

        const stripEmbeddedPdfImages = async () => {
          let fixedCount = 0;
          const indirectObjects = src.context.enumerateIndirectObjects();
          for (const [ref, object] of indirectObjects) {
            if (!object || typeof object !== 'object') continue;
            const stream = object;
            if (!stream.dict) continue;

            let subtype = null;
            let type = null;
            let filter = null;
            try {
              if (typeof stream.dict.lookupMaybe === 'function') {
                subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
                type = stream.dict.lookupMaybe(PDFName.of('Type'), PDFName);
                filter = stream.dict.lookupMaybe(PDFName.of('Filter'));
              } else if (typeof stream.dict.get === 'function') {
                subtype = stream.dict.get(PDFName.of('Subtype'));
                type = stream.dict.get(PDFName.of('Type'));
                filter = stream.dict.get(PDFName.of('Filter'));
              }
            } catch (e) {
              // If we cannot read dict entries, skip this object
              continue;
            }

            if (!subtype || !(subtype instanceof PDFName) || subtype !== PDFName.of('Image')) continue;
            if (type && type instanceof PDFName && type !== PDFName.of('XObject') && type !== PDFName.of('Image')) continue;

            if (!isDctDecode(filter)) continue;

            const raw = stream.getContents ? stream.getContents() : null;
            if (!raw || !(raw instanceof Uint8Array || Buffer.isBuffer(raw))) continue;

            try {
              const cleanedJpeg = await sharp(Buffer.from(raw))
                .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
                .toBuffer();

              const newDict = stream.dict.clone(src.context);
              const replacement = src.context.stream(cleanedJpeg, newDict);
              src.context.assign(ref, replacement);
              fixedCount += 1;
            } catch (err) {
              // If a JPEG cannot be processed, skip and continue.
            }
          }

          return fixedCount;
        };

        // Apply removals based on options
        removePdfInfo();
        flattenAndRemoveAnnotations();
        if (removeGPS || removeDevice) {
          await stripEmbeddedPdfImages();
        }

        if (enableBlur) {
          // AI blur not implemented in this offline build. Log and continue.
          console.warn('enableBlur requested but not implemented; skipping AI blur.');
        }

        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((page) => out.addPage(page));

        if (out.context.trailerInfo.Info) {
          delete out.context.trailerInfo.Info;
        }
        const outCatalog = out.context.lookup(out.context.trailerInfo.Root, PDFDict);
        if (outCatalog instanceof PDFDict) {
          outCatalog.delete(PDFName.of('Metadata'));
          outCatalog.delete(PDFName.of('OpenAction'));
          outCatalog.delete(PDFName.of('AA'));
          outCatalog.delete(PDFName.of('OCProperties'));
          outCatalog.delete(PDFName.of('AcroForm'));
        }

        const outBytes = await out.save();
        res.type('application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="cleaned-${req.file.originalname}"`);
        return res.send(Buffer.from(outBytes));
      } catch (err) {
        console.error('PDF clean error', err);
        return res.status(500).json({ error: 'Unable to clean PDF.' });
      }
    }

    return res.status(400).json({ error: 'Unsupported file type for cleaning.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to clean image metadata.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MetaGuard backend listening on http://localhost:${port}`);
});
