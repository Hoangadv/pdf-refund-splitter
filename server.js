const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

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

// ===== WORKFLOW: Scan page 1 → Extract LO 000-800 =====
function extractLOLines(text) {
    const lines = text.split('\n');
    const loLines = [];
    
    console.log('\n=== WORKFLOW: Extract LO from Page 1 ===\n');
    
    // DEBUG: Print first 50 lines to see format
    console.log('--- DEBUG: First 30 lines of text ---');
    for (let i = 0; i < Math.min(30, lines.length); i++) {
        console.log(`Line ${i}: "${lines[i]}"`);
    }
    console.log('--- END DEBUG ---\n');
    
    // STEP 1: Find header "LO" with Cash/Check
    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('LO') && (lines[i].includes('Cash') || lines[i].includes('Check'))) {
            headerIndex = i;
            console.log(`✓ STEP 1: Found header at line ${i}`);
            console.log(`  Header: "${lines[i]}"\n`);
            break;
        }
    }
    
    if (headerIndex === -1) {
        console.log('❌ Header not found. Exiting.\n');
        return [];
    }
    
    // STEP 2: Process lines AFTER header
    console.log(`✓ STEP 2: Processing data rows after header\n`);
    
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        
        // STOP at page break/footer
        if (line.includes('*Declining') || 
            line.includes('(Print Name)') ||
            line.includes('ASHLEY GLOBAL') ||
            line.includes('kputman')) {
            console.log(`\n✓ STEP 3: Reached page end at line ${i}\n`);
            break;
        }
        
        // STEP 3: Extract LO - Try multiple patterns
        // Pattern 1: Word boundary 3-digits (000-800)
        let loMatch = line.match(/\b(0\d{2}|[1-7]\d{2}|800)\b/);
        
        // Pattern 2: If no boundary match, try loose pattern
        if (!loMatch) {
            loMatch = line.match(/(0\d{2}|[1-7]\d{2}|800)/);
        }
        
        if (loMatch) {
            const lo = loMatch[1];
            loLines.push({
                lo: lo,
                fullLine: line
            });
            console.log(`  Line ${i}: LO="${lo}" ✓ | Line: "${line.substring(0, 80)}"`);
        }
    }
    
    console.log(`\n✓ STEP 4: Total LO extracted: ${loLines.length}`);
    if (loLines.length > 0) {
        const uniqueLOs = [...new Set(loLines.map(l => l.lo))].sort();
        console.log(`  Unique LO: [${uniqueLOs.join(', ')}]\n`);
    } else {
        console.log('  (No valid LO found)\n');
    }
    
    return loLines;
}

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

app.post('/api/process-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const pdfBuffer = req.file.buffer;
        
        // Extract text from PAGE 1 ONLY
        let pdfData;
        try {
            pdfData = await pdfParse(pdfBuffer, { max: 1 });
        } catch (err) {
            return res.status(400).json({ success: false, error: 'Invalid PDF: ' + err.message });
        }

        const textFirstPage = pdfData.text;
        const loLines = extractLOLines(textFirstPage);

        if (loLines.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: `No valid LO data found on page 1.` 
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
            // Create a PDF for each unique LO
            for (const [lo, lines] of Object.entries(groupedLOs)) {
                const newPdf = await PDFDocument.create();
                
                const page1 = newPdf.addPage([612, 792]);
                const { height } = page1.getSize();
                
                let yPosition = height - 50;
                for (const line of lines) {
                    page1.drawText(line, {
                        x: 50,
                        y: yPosition,
                        size: 9,
                        lineHeight: 12,
                        maxWidth: 500
                    });
                    yPosition -= 18;
                }

                // Copy remaining pages from original PDF
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

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
