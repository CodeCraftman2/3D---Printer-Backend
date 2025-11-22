const express = require('express');
const multer = require('multer');
const cors = require('cors');

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Add after the existing requires
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());


// Add this middleware to parse JSON (add after the cors middleware)
app.use(express.json());


// Use memory storage to keep files in memory instead of disk
const upload = multer({ storage: multer.memoryStorage() });
// Add this after the existing multer setup
let uploadedFile = null; // Store the uploaded file globally

function clearUploadedFile() {
  if (uploadedFile) {
    console.log('🧹 Clearing uploaded file from memory:', uploadedFile.filename);
    uploadedFile = null;
  }
}

// New: configurable port and PrusaSlicer path
const PORT = process.env.PORT || 5000;
const PRUSA_SLICER_PATH = process.env.PRUSA_SLICER_PATH || 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe';
const hasPrusaSlicer = fs.existsSync(PRUSA_SLICER_PATH);

// Helper to calculate size from vertices
function getSize(verts) {
  if (!verts.length) throw new Error('No vertices found');

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const [x, y, z] of verts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  return {
    x: maxX - minX,
    y: maxY - minY,
    z: maxZ - minZ,
    vertexCount: verts.length
  };
}

// Parse OBJ file content
function readOBJ(buf) {
  const txt = new TextDecoder().decode(buf);
  const lines = txt.split('\n');
  const verts = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      const [x, y, z] = parts.slice(1).map(Number);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        verts.push([x, y, z]);
      }
    }
  }

  if (!verts.length) throw new Error('No valid vertices in OBJ');
  return verts;
}

// Parse STL (binary or ASCII)
function readSTL(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = new DataView(ab);

  // Try binary first
  if (ab.byteLength > 84) {
    const triangles = view.getUint32(80, true);
    if (ab.byteLength === 84 + triangles * 50) return readBinarySTL(ab, triangles);
  }

  // Fallback to ASCII
  const text = new TextDecoder().decode(ab);
  if (text.toLowerCase().includes('solid') && text.toLowerCase().includes('facet')) {
    return readASCIISTL(text);
  }

  throw new Error('Not a valid STL file');
}

// Read ASCII STL
function readASCIISTL(txt) {
  const verts = [];
  const lines = txt.split('\n');

  for (const line of lines) {
    const parts = line.trim().toLowerCase().split(/\s+/);
    if (parts[0] === 'vertex' && parts.length === 4) {
      const [x, y, z] = parts.slice(1).map(Number);
      verts.push([x, y, z]);
    }
  }

  return verts;
}

// Read Binary STL
function readBinarySTL(ab, count) {
  const view = new DataView(ab);
  const verts = [];
  let offset = 84;

  for (let i = 0; i < count; i++) {
    offset += 12; // skip normal
    for (let j = 0; j < 3; j++) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      verts.push([x, y, z]);
      offset += 12;
    }
    offset += 2; // skip attribute
  }

  return verts;
}


// Upload and calculate dimensions
app.post('/api/dimensions', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    if (!['stl', 'obj'].includes(ext)) {
      return res.status(400).json({ error: `Only STL and OBJ supported, not ${ext}` });
    }

    const file = req.file.buffer;
    if (!file || !file.length) {
      return res.status(400).json({ error: 'File is empty or corrupted' });
    }

    console.log(`📂 Got ${ext.toUpperCase()} file:`, req.file.originalname, `(${file.length} bytes)`);

    let verts;
    if (ext === 'stl') verts = readSTL(file);
    if (ext === 'obj') verts = readOBJ(file);

    const size = getSize(verts);
    console.log(`✅ Done. Found ${size.vertexCount} vertices.`, size);

    // Store the file for later use
    uploadedFile = {
      buffer: req.file.buffer,
      filename: req.file.originalname,
      extension: ext
    };

    setTimeout(() => {
      if (uploadedFile && uploadedFile.filename === req.file.originalname) {
        console.log('⏰ Auto-clearing uploaded file after 30 minutes');
        clearUploadedFile();
      }
    }, 30 * 60 * 1000);

    res.json(size);

  } catch (err) {
    console.error('❌ Error reading file:', err.message);
    res.status(500).json({ error: err.message });
  }
});


const getMaterialSettings = (material, materialType) => {
  const settings = {
    'PLA': {
      extruder: 210,
      bed: 60,
      firstLayerTemp: 215,
      coolingFanSpeed: 100,
      retractionLength: 2,
      retractionSpeed: 40
    },
    'ABS': {
      extruder: 250,
      bed: 100,  // Updated to match your spec
      firstLayerTemp: 255,
      coolingFanSpeed: 30,
      retractionLength: 1,
      retractionSpeed: 40  // Added default
    },
    'PETG': {
      extruder: 240,  // Updated to match your spec
      bed: 80,        // Updated to match your spec
      firstLayerTemp: 245,
      coolingFanSpeed: 50,
      retractionLength: 3,
      retractionSpeed: 40  // Added default
    },
    'TPU': {
      extruder: 220,
      bed: 50,
      firstLayerTemp: 225,  // Added
      coolingFanSpeed: 80,  // Added
      retractionLength: 0.5, // Added
      retractionSpeed: 25   // Added
    },
    'PC': {
      extruder: 280,
      bed: 100,
      firstLayerTemp: 285,  // Added
      coolingFanSpeed: 40,  // Added
      retractionLength: 1.5, // Added
      retractionSpeed: 35   // Added
    },
    'ASA': {
      extruder: 250,
      bed: 80,
      firstLayerTemp: 255,  // Added
      coolingFanSpeed: 30,  // Added (similar to ABS)
      retractionLength: 1,  // Added
      retractionSpeed: 40   // Added
    },
    'PEEK': {
      extruder: 400,
      bed: 120,
      firstLayerTemp: 405,  // Added
      coolingFanSpeed: 20,  // Added
      retractionLength: 1,  // Added
      retractionSpeed: 30   // Added
    },
    'Nylon': {
      extruder: 270,
      bed: 80,
      firstLayerTemp: 275,  // Added
      coolingFanSpeed: 60,  // Added
      retractionLength: 2,
      retractionSpeed: 35
    }
  };
  return settings[material] || {
    extruder: 210,
    bed: 60,
    firstLayerTemp: 215,
    coolingFanSpeed: 100,
    retractionLength: 2,
    retractionSpeed: 40
  };
};



// Function to parse print time from G-code
function parsePrintTime(gcodeContent) {
  const lines = gcodeContent.split('\n');
  let printTime = 'Unknown';

  for (const line of lines) {
    if (line.includes('; estimated printing time')) {
      const match = line.match(/; estimated printing time[^=]*=\s*(.+)/);
      if (match) {
        printTime = match[1].trim();
        break;
      }
    }
  }

  return printTime;
}


function generatePrusaCommand(config, inputFilePath, outputFilePath) {
  const materialSettings = getMaterialSettings(config.material);

  let layerHeight = 0.2;
  if (config.nozzleSize <= 0.3) {
    layerHeight = Math.max(0.1, config.nozzleSize * 0.5); // 50% of nozzle diameter, minimum 0.1mm
  }

  const args = [
    '--nozzle-diameter', config.nozzleSize.toString(),
    '--filament-type', config.materialType || config.material,
    '--temperature', materialSettings.extruder.toString(),
    '--first-layer-temperature', materialSettings.firstLayerTemp.toString(),
    '--bed-temperature', materialSettings.bed.toString(),
    '--retract-length', materialSettings.retractionLength.toString(),
    '--retract-speed', materialSettings.retractionSpeed.toString(),
    '--fill-density', `${config.fillDensity}%`,
    '--layer-height', layerHeight.toString(),
    '--bed-shape', '0x0,300x0,300x300,0x300',
    '--export-gcode',
    '--output', outputFilePath,
    inputFilePath
  ];

  if (config.supportMaterial) {
    args.splice(-3, 0, '--support-material');
  }

  return args;
}



app.post('/api/submit-configuration', async (req, res) => {
  try {
    console.log('📋 Processing configuration:', req.body);

    // If PrusaSlicer is not available, return 503 with clear guidance
    if (!hasPrusaSlicer) {
      console.warn('PrusaSlicer not available at configured path:', PRUSA_SLICER_PATH);
      return res.status(503).json({
        error: 'PrusaSlicer is not available on this server. Set PRUSA_SLICER_PATH environment variable to the slicer binary path or provide pre-sliced G-code from the client.'
      });
    }

    const {
      designUnit,
      material,
      materialType,
      customMaterials,
      nozzleSize,
      fillDensity,
      supportMaterial
    } = req.body;

    // Check if file was uploaded
    if (!uploadedFile) {
      return res.status(400).json({
        error: 'No 3D model file found. Please upload a file first.'
      });
    }

    // Validate required fields
    if (!material || !designUnit || nozzleSize === undefined || fillDensity === undefined || !materialType) {
      return res.status(400).json({
        error: 'Missing required fields: material, material type, designUnit, nozzleSize, and fillDensity are required'
      });
    }



    // Validate ranges
    if (nozzleSize < 0.2 || nozzleSize > 1.0) {
      return res.status(400).json({
        error: 'Nozzle size must be between 0.2 and 1.0 mm'
      });
    }

    if (fillDensity < 0 || fillDensity > 100) {
      return res.status(400).json({
        error: 'Fill density must be between 0 and 100%'
      });
    }

    // Create temporary files
    const tempDir = os.tmpdir();
    const tempInputFile = path.join(tempDir, `input_${Date.now()}.${uploadedFile.extension}`);
    const tempOutputFile = path.join(tempDir, `output_${Date.now()}.gcode`);

    try {
      // Write uploaded file to temp location
      fs.writeFileSync(tempInputFile, uploadedFile.buffer);

      if (!fs.existsSync(tempInputFile)) {
        throw new Error('Failed to create temporary input file');
      }

      const fileStats = fs.statSync(tempInputFile);

      const config = {
        material,
        materialType,
        nozzleSize: parseFloat(nozzleSize),
        fillDensity: parseInt(fillDensity),
        supportMaterial: Boolean(supportMaterial)
      };

      // Try a minimal command first
      const prusaArgs = generatePrusaCommand(config, tempInputFile, tempOutputFile);
      // Use configured PrusaSlicer path (set via PRUSA_SLICER_PATH env var)
      const prusaPath = PRUSA_SLICER_PATH;

      let prusaStdout = '';
      let prusaStderr = '';
      let prusaError = null;

      try {
        const { stdout, stderr } = await execFileAsync(prusaPath, prusaArgs, {
          timeout: 120000,
          windowsHide: true,
          encoding: 'utf8'
        });

        prusaStdout = stdout || '';
        prusaStderr = stderr || '';
      } catch (execError) {
        prusaError = execError;
        prusaStdout = execError.stdout || '';
        prusaStderr = execError.stderr || '';
      }


      // Check if output file was created
      if (!fs.existsSync(tempOutputFile)) {
        throw new Error('PrusaSlicer did not create output file, try using different input file or settings');
      }

      // Read and parse the generated G-code
      const gcodeContent = fs.readFileSync(tempOutputFile, 'utf8');
      const printTime = parsePrintTime(gcodeContent);

      // Clean up temp files
      fs.unlinkSync(tempInputFile);
      fs.unlinkSync(tempOutputFile);

      const processedConfig = {
        designUnit,
        material,
        materialType: materialType || null,
        customMaterials: customMaterials || null,
        nozzleSize: parseFloat(nozzleSize),
        fillDensity: parseInt(fillDensity),
        supportMaterial: Boolean(supportMaterial),
        printTime: printTime,
        processedAt: new Date().toISOString(),
        filename: uploadedFile.filename,
      };

      console.log('✅ Configuration processed successfully with print time:', printTime);

      res.status(200).json({
        success: true,
        message: 'Configuration processed successfully',
        data: processedConfig
      });

    } catch (prusaError) {
      try {
        if (fs.existsSync(tempInputFile)) fs.unlinkSync(tempInputFile);
        if (fs.existsSync(tempOutputFile)) fs.unlinkSync(tempOutputFile);
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }


      console.error('❌ PrusaSlicer error details:', {
        message: prusaError.message,
        code: prusaError.code,
        signal: prusaError.signal,
        stdout: prusaError.stdout,
        stderr: prusaError.stderr
      });

      res.status(500).json({
        error: `PrusaSlicer processing failed: ${prusaError.message}`,
        details: {
          code: prusaError.code,
          stderr: prusaError.stderr
        }
      });
    }

  } catch (err) {
    console.error('❌ Error processing configuration:', err.message);
    res.status(500).json({
      error: 'Internal server error while processing configuration'
    });
  }
});


app.listen(PORT, () => console.log(`🚀 Server ready on http://localhost:${PORT}`));
