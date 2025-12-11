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

// Extract LO from character position (second-to-last column)
function extractLOLines(text) {
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    const loLines = [];
    
    console.log('\n=== DEBUG: Analyzing PDF ===');
    console.log('Total lines:', lines.length);
    
    // Find header row containing "LO"
    let headerIndex = -1;
    let loCharStartPos = -1;
    let loCharEndPos = -1;
    
    for (let i = 0; i < Math.min(20, lines.length); i++) {
        console.log(`Line ${i}: "${lines[i]}"`);
        
        if (lines[i].includes('LO')) {
            headerIndex = i;
            const headerLine = lines[i];
            console.log('\n✓ Found header at line', i);
            
            // Find "LO" position in header
            const loPos = headerLine.indexOf('LO');
            console.log('LO text starts at character position:', loPos);
            
            // Find the start and end of LO column
            // Look backwards from LO to find where column starts (usually space)
            let colStart = loPos;
            while (colStart > 0 && headerLine[colStart - 1] !== ' ') {
                colStart--;
            }
            
            // Look forwards from LO to find where column ends (usually space)
            let colEnd = loPos + 2;
            while (colEnd < headerLine.length && headerLine[colEnd] !== ' ') {
                colEnd++;
            }
            
            loCharStartPos = colStart;
            loCharEndPos = colEnd;
            
            console.log(`LO column is at character positions ${colStart}-${colEnd}`);
            console.log(`Header substring: "${headerLine.substring(Math.max(0, colStart - 5), Math.min(headerLine.length, colEnd + 5))}"`);
            break;
        }
    }
    
    if (headerIndex === -1) {
        console.log('❌ Could not find header with LO');
        return [];
    }
    
    // Extract LO from data rows using character position
    const dataStartIndex = headerIndex + 1;
    let validCount = 0;
    
    for (let i = dataStartIndex; i < lines.length && validCount < 20; i++) {
        const line = lines[i];
        
        if (!line || line.length < 5) continue;
        
        // Extract substring from LO column position
        let loValue = '';
        if (line.length >= loCharEndPos) {
            loValue = line.substring(loCharStartPos, loCharEndPos).trim();
        } else if (line.length >= loCharStartPos) {
            loValue = line.substring(loCharStartPos).trim();
        }
        
        // Validate: must be exactly 3 digits
        if (/^\d{3}$/.test(loValue)) {
            loLines.push({
                lo: loValue,
                fullLine: line
            });
            console.log(`Line ${i}: Extracted LO = "${loValue}"`);
            validCount++;
        } else if (loValue) {
            console.log(`Line ${i}: Got "${loValue}" (invalid - not 3 digits)`);
        }
    }
    
    console.log(`\n✓ Total valid LO lines found: ${loLines.length}\n`);
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
    
    console.log('Unique LO values:', Object.keys(grouped).sort().join(', '));
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
        
        const loLines = extractLOLines(textFirstPage);

        if (loLines.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: `No valid LO data found. Expected 3-digit values in LO column.` 
            });
        }

        // Group by LO
        const groupedLOs = groupByLO(loLines);

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
            console.log('=== PDF Processing Complete ===\n');
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
