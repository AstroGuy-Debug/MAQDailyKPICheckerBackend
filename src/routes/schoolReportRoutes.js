import express from 'express';
import SchoolReport from '../models/SchoolReport.js';
import { protect, omOnly } from '../middleware/authMiddleware.js';

const router = express.Router();

// @desc    Upload batch of parsed school reports
// @route   POST /api/school-reports/batch
// @access  Private (POC-SCHOOL)
router.post('/batch', protect, async (req, res) => {
    try {
        const { reports } = req.body;

        if (!reports || !Array.isArray(reports)) {
            return res.status(400).json({ message: 'Invalid reports format' });
        }

        // Attach user object ID to each report
        const reportsWithUser = reports.map(r => ({
            ...r,
            uploader: req.user._id,
        }));

        // Insert into database
        const inserted = await SchoolReport.insertMany(reportsWithUser);

        res.status(201).json({ message: 'Batch upload successful', count: inserted.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server upload error', error: error.message });
    }
});

// @desc    Get all school reports (with optional date range filtering)
// @route   GET /api/school-reports
// @access  Private
router.get('/', protect, async (req, res) => {
    try {
        const { endorsementDate, startDate, endDate, uploader } = req.query;

        let query = {};

        if (startDate && endDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            query.endorsementDate = { $gte: start, $lte: end };
        } else if (endorsementDate) {
            const startOfDay = new Date(endorsementDate);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(endorsementDate);
            endOfDay.setHours(23, 59, 59, 999);
            query.endorsementDate = { $gte: startOfDay, $lte: endOfDay };
        }

        if (req.user.role === 'POC-SCHOOL') {
            query.uploader = req.user._id;
        } else if (uploader) {
            query.uploader = uploader;
        }

        const reports = await SchoolReport.find(query).populate('uploader', 'email').sort({ endorsementDate: -1 });
        res.json(reports);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching school reports', error: error.message });
    }
});

// @desc    Get daily KPI for POC-SCHOOL
// @route   GET /api/school-reports/kpi
// @access  Private (POC-SCHOOL)
router.get('/kpi', protect, async (req, res) => {
    try {
        const { date } = req.query;

        // Default to today
        const targetDate = date ? new Date(date) : new Date();
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const uploaderId = req.user.role === 'POC-SCHOOL' ? req.user._id : undefined;

        let matchQuery = {
            createdAt: { $gte: startOfDay, $lte: endOfDay }
        };
        if (uploaderId) {
            matchQuery.uploader = uploaderId;
        }

        // Get all reports for the day
        const reports = await SchoolReport.find(matchQuery);

        // Calculate KPI
        const accountBreakdown = {};
        reports.forEach(r => {
            const acct = r.account || 'Unknown';
            if (!accountBreakdown[acct]) {
                accountBreakdown[acct] = { total: 0, policy: 0, result: 0, closed: 0, pending: 0 };
            }
            accountBreakdown[acct].total++;
            if (r.status === 'policy') accountBreakdown[acct].policy++;
            else if (r.status === 'result') accountBreakdown[acct].result++;
            else if (r.status === 'closed thru internal') accountBreakdown[acct].closed++;
            else accountBreakdown[acct].pending++;
        });

        // Overall Totals
        const totalProcessed = reports.length;
        const totalPolicy = reports.filter(r => r.status === 'policy').length;
        const totalResult = reports.filter(r => r.status === 'result').length;
        const totalClosed = reports.filter(r => r.status === 'closed thru internal').length;
        const totalPending = reports.filter(r => r.status === 'pending').length;

        res.json({
            date: startOfDay.toISOString().substring(0, 10),
            totalProcessed,
            totalPolicy,
            totalResult,
            totalClosed,
            totalPending,
            accountBreakdown
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching school KPI', error: error.message });
    }
});

// @desc    Get school performance stats for OM
// @route   GET /api/school-reports/stats
// @access  Private/OM
router.get('/stats', protect, omOnly, async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const pastDays = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            return d.toISOString().substring(0, 10);
        }).reverse(); // array of YYYY-MM-DD for last 7 days

        let totalProcessed = 0;
        let totalPolicy = 0;
        let totalResult = 0;
        let totalClosed = 0;
        let totalPending = 0;

        const reports = await SchoolReport.find({});

        reports.forEach((r) => {
            totalProcessed++;
            if (r.status === 'policy') totalPolicy++;
            else if (r.status === 'result') totalResult++;
            else if (r.status === 'closed thru internal') totalClosed++;
            else totalPending++;
        });

        res.json({ totalProcessed, totalPolicy, totalResult, totalClosed, totalPending, pastDays });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching school stats', error: error.message });
    }
});

export default router;
