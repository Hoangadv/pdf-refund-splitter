const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer setup cho upload file
const upload = multer({ 
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files allowed'));
        }
    }
});

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Hàm trích xuất text từ PDF (sử dụng pdf-parse hoặc pdf2json)
async function extractTextFromPdf(buffer) {
    try {
        const pdfDoc = await PDFLib.load(buffer);
        let fullText = '';
        
        for (let i = 0; i < pdfDoc.getPageCount(); i++) {
            const page = pdfDoc.getPage(i);
            // Note: pdf-lib không hỗ trợ text extraction trực tiếp
            // Dùng pdf-parse hoặc pdfjs-dist thay thế
        }
        
        return fullText;
    } catch (error) {
        throw new Error('Failed to extract text from PDF: ' + error.message);
    }
}

// Hàm tìm ngày từ text
function extractDate(text) {
    const dateMatch = text.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})/);
    
    if (dateMatch) {
        const months = {
            'january':'01','february':'02','march':'03','april':'04',
            'may':'05','june':'06','july':'07','august':'08',
            'september':'09','october':'10','november':'11','december':'12'
        };
        const [, month, day, year] = dateMatch;
        const monthNum = months[month.toLowerCase()] || '01';
        const dayStr = day.padStart(2, '0');
        const yearStr = year.slice(-2);
        return `${monthNum}${dayStr}${yearStr}`;
    }
    
    // Fallback: dùng ngày hiện tại
    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const y = String(now.getFullYear()).slice(-2);
    return `${m}${d}${y}`;
}

// Hàm tìm các LO từ text
function extractLOData(text) {
    const loData = {};
    
    // Pattern: "65 659084 <date> <saleid> $<amount> <name> ... <lo>"
    const pattern = /65\s+659084\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+([^\s]+)\s+\$?\s*([\d,]+\.\d{2})\s+(.+?)\s+([A-Z]{2})\s+(\d{5})\s+(\d{3})/g;
    
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const [, date, saleId, amount, name, state, zip, lo] = match;
        
        if (!loData[lo]) {
            loData[lo] = [];
        }
        
        loData[lo].push({
            date,
            saleId,
            amount,
            name: name.trim(),
            state,
            zip,
            lo
        });
    }
    
    return loData;
}

// Hàm tạo trang 1 (dòng LO)
function createLOPage(loInfo) {
    const doc = new PDFDocument({ size: 'LETTER' });
    
    doc.fontSize(24).font('Helvetica-Bold');
    doc.text(`LO ${loInfo.lo}`, { align: 'left' });
    
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Date: ${loInfo.date}`, { align: 'left' });
    doc.text(`Sale ID: ${loInfo.saleId}`, { align: 'left' });
    doc.text(`Amount: $${loInfo.amount}`, { align: 'left' });
    doc.text(`Customer: ${loInfo.name}`, { align: 'left' });
    doc.text(`Location: ${loInfo.state} ${loInfo.zip}`, { align: 'left' });
    
    doc.moveDown(1);
    doc.fontSize(10).fillColor('#999999');
    doc.text(`Generated: ${new Date().toLocaleString('en-US')}`, { align: 'center' });
    
    return doc;
}

// API endpoint: Upload và process PDF
app.post('/api/process-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const pdfBuffer = req.file.buffer;
        
        // Sử dụng pdf-parse để extract text
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(pdfBuffer);
        const fullText = pdfData.text;
        
        // Trích xuất ngày
        const dateStr = extractDate(fullText);
        
        // Trích xuất LO data
        const loData = extractLOData(fullText);
        
        if (Object.keys(loData).length === 0) {
            return res.status(400).json({ 
                error: 'No LO data found in PDF. Check file format.' 
            });
        }
        
        // Load PDF gốc để lấy 2 trang cuối
        const originalPdf = await PDFLib.load(pdfBuffer);
        const totalPages = originalPdf.getPageCount();
        const lastTwoPageIndices = [totalPages - 2, totalPages - 1].filter(i => i >= 0);
        
        // Tạo ZIP chứa tất cả file
        const archiveFileName = `refund-split-${dateStr}.zip`;
        const archivePath = path.join(__dirname, 'temp', archiveFileName);
        
        // Tạo thư mục temp nếu chưa có
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
            fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
        }
        
        const output = fs.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        archive.pipe(output);
        
        // Tạo file PDF cho mỗi LO
        const generatedFiles = [];
        
        for (const [lo, dataArray] of Object.entries(loData)) {
            for (let idx = 0; idx < dataArray.length; idx++) {
                const loInfo = dataArray[idx];
                const fileName = `${dateStr}-${lo}.pdf`;
                
                // Tạo PDF mới
                const newPdf = await PDFLib.create();
                
                // Trang 1: Dòng LO
                const loDoc = createLOPage(loInfo);
                const loDocBuffer = await new Promise((resolve, reject) => {
                    const chunks = [];
                    loDoc.on('data', chunk => chunks.push(chunk));
                    loDoc.on('end', () => resolve(Buffer.concat(chunks)));
                    loDoc.on('error', reject);
                    loDoc.end();
                });
                
                const loDocPdf = await PDFLib.load(loDocBuffer);
                const loPages = loDocPdf.getPages();
                for (const page of loPages) {
                    const copiedPage = await newPdf.embedPage(page);
                    newPdf.addPage([612, 792]);
                    newPdf.drawPage(copiedPage);
                }
                
                // Trang 2-3: 2 trang cuối từ PDF gốc
                for (const pageIdx of lastTwoPageIndices) {
                    if (pageIdx >= 0 && pageIdx < totalPages) {
                        const page = originalPdf.getPage(pageIdx);
                        const copiedPage = await newPdf.embedPage(page);
                        newPdf.addPage([612, 792]);
                        newPdf.drawPage(copiedPage);
                    }
                }
                
                // Lưu PDF vào buffer
                const pdfBytes = await newPdf.save();
                
                // Thêm vào ZIP
                archive.append(Buffer.from(pdfBytes), { name: fileName });
                generatedFiles.push(fileName);
            }
        }
        
        // Hoàn tất ZIP
        archive.finalize();
        
        output.on('close', () => {
            res.json({
                success: true,
                dateStr,
                loCount: Object.keys(loData).length,
                fileCount: generatedFiles.length,
                files: generatedFiles,
                downloadUrl: `/download/${archiveFileName}`
            });
        });
        
        output.on('error', (err) => {
            res.status(500).json({ error: 'Failed to create ZIP: ' + err.message });
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint: Download ZIP
app.get('/download/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'temp', req.params.filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath, req.params.filename, (err) => {
            if (err) console.error('Download error:', err);
            // Xóa file sau khi download
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }, 1000);
        });
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📝 API: POST /api/process-pdf (upload PDF)`);
    console.log(`📥 Download: GET /download/:filename`);
});
