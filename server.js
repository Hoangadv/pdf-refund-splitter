const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files allowed'));
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Create temp directory
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Extract date from text
function extractDate(text) {
    const dateMatch = text.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})/);
    if (dateMatch) {
        const months = {
            'january': '01', 'february': '02', 'march': '03', 'april': '04',
            'may': '05', 'june': '06', 'july': '07', 'august': '08',
            'september': '09', 'october': '10', 'november': '11', 'december': '12'
        };
        const [, month, day, year] = dateMatch;
        const monthNum = months[month.toLowerCase()] || '01';
        const dayStr = String(day).padStart(2, '0');
        const yearStr = String(year).slice(-2);
        return `${monthNum}${dayStr}${yearStr}`;
    }
    
    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const y = String(now.getFullYear()).slice(-2);
    return `${m}${d}${y}`;
}

// Extract LO lines from first page
function extractLOLines(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const loLines = [];
    
    // Find header row (contains "LO")
    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('LO')) {
            headerIndex = i;
            console.log('Found header at index', i, ':', lines[i]);
            break;
        }
    }
    
    if (headerIndex === -1) {
        console.log('Warning: Could not find header');
        return [];
    }
    
    // Extract next lines as data rows (up to 13 or more)
    const dataStartIndex = headerIndex + 1;
    let validCount = 0;
    
    for (let i = dataStartIndex; i < lines.length && validCount < 20; i++) {
        const line = lines[i];
        
        if (!line || line.length < 5) continue;
        
        // Try to extract LO - it's typically 3 digits after "LO" marker
        // Split by spaces and look for 3-digit numbers
        const parts = line.split(/\s+/);
        
        let lo = null;
        
        // Find 3-digit number that could be LO (usually not the last one)
        for (let j = 0; j < parts.length - 1; j++) {
            const part = parts[j];
            if (/^\d{3}$/.test(part)) {
                // Found a potential LO, but skip if it's too far to the left
                const beforeLO = parts.slice(0, j).join(' ');
                if (beforeLO.length > 20) { // Ensure there's data before LO
                    lo = part;
                    break;
                }
            }
        }
        
        // If no LO found in middle, try the second-to-last 3-digit number
        if (!lo) {
            for (let j = parts.length - 2; j >= 0; j--) {
                const part = parts[j];
                if (/^\d{3}$/.test(part)) {
                    lo = part;
                    break;
                }
            }
        }
        
        if (lo) {
            loLines.push({
                lo: lo,
                fullLine: line
            });
            console.log('Extracted LO:', lo, 'from:', line.substring(0, 50) + '...');
            validCount++;
        }
    }
    
    console.log('Total LO lines found:', loLines.length);
    return loLines;
}

// Group LO lines by LO value
function groupByLO(loLines) {
    const grouped = {};
    
    for (const item of loLines) {
        if (!grouped[item.lo]) {
            grouped[item.lo] = [];
        }
        grouped[item.lo].push(item.fullLine);
    }
    
    return grouped;
}

// Process PDF endpoint
app.post('/api/process-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const pdfBuffer = req.file.buffer;
        
        // Extract text from first page
        let pdfData;
        try {
            pdfData = await pdfParse(pdfBuffer);
        } catch (err) {
            return res.status(400).json({ success: false, error: 'Invalid PDF: ' + err.message });
        }

        const textFirstPage = pdfData.text;
        console.log('PDF Text (first 500 chars):', textFirstPage.substring(0, 500));
        
        const loLines = extractLOLines(textFirstPage);

        if (loLines.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: `No LO data found. Expected data rows with 3-digit LO. Found: 0 lines` 
            });
        }

        // Group by LO
        const groupedLOs = groupByLO(loLines);
        console.log('Grouped LOs:', Object.keys(groupedLOs));

        const dateStr = extractDate(textFirstPage);
        const zipFileName = `refund-split-${dateStr}.zip`;
        const zipPath = path.join(tempDir, zipFileName);

        // Load original PDF
        let originalPdf;
        try {
            originalPdf = await PDFDocument.load(pdfBuffer);
        } catch (err) {
            return res.status(400).json({ success: false, error: 'Cannot load PDF: ' + err.message });
        }

        const totalPages = originalPdf.getPageCount();

        // Create ZIP
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', (err) => {
            return res.status(500).json({ success: false, error: err.message });
        });

        archive.pipe(output);

        const generatedFiles = [];

        try {
            // Create a PDF for each unique LO (with grouped lines)
            for (const [lo, lines] of Object.entries(groupedLOs)) {
                const newPdf = await PDFDocument.create();
                
                // Page 1: All LO data lines (can be 1, 2, 3, etc.)
                const page1 = newPdf.addPage([612, 792]);
                const { height } = page1.getSize();
                
                // Draw all lines for this LO
                let yPosition = height - 50;
                for (const line of lines) {
                    page1.drawText(line, {
                        x: 50,
                        y: yPosition,
                        size: 9,
                        lineHeight: 12,
                        maxWidth: 500
                    });
                    yPosition -= 18; // Move down for next line
                }

                // Pages 2+: Copy remaining pages (page 2 onwards) from original PDF
                if (totalPages > 1) {
                    const remainingPageIndices = [];
                    for (let i = 1; i < totalPages; i++) {
                        remainingPageIndices.push(i);
                    }
                    
                    if (remainingPageIndices.length > 0) {
                        const copiedPages = await newPdf.copyPages(originalPdf, remainingPageIndices);
                        copiedPages.forEach(copiedPage => {
                            newPdf.addPage(copiedPage);
                        });
                    }
                }

                // Save PDF
                const pdfBytes = await newPdf.save();
                const fileName = `${dateStr}-${lo}.pdf`;
                
                archive.append(Buffer.from(pdfBytes), { name: fileName });
                generatedFiles.push(fileName);
            }

            archive.finalize();

        } catch (err) {
            return res.status(500).json({ success: false, error: 'PDF creation failed: ' + err.message });
        }

        output.on('close', () => {
            res.json({
                success: true,
                dateStr,
                loCount: Object.keys(groupedLOs).length,
                fileCount: generatedFiles.length,
                files: generatedFiles,
                downloadUrl: `/download/${zipFileName}`
            });
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Download endpoint
app.get('/download/:filename', (req, res) => {
    const filePath = path.join(tempDir, req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, req.params.filename, (err) => {
        if (!err) {
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                } catch (e) {
                    console.error('Cleanup error:', e);
                }
            }, 2000);
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📝 API: POST /api/process-pdf`);
    console.log(`📥 Download: GET /download/:filename`);
    console.log(`❤️  Health: GET /health`);
});
