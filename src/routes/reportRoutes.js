import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import Report from '../models/Report.js';

const router = express.Router();

// @desc    Batch insert parsed Excel reports
// @route   POST /api/reports/batch
// @access  Private
router.post('/batch', protect, async (req, res) => {
    try {
        const { reports } = req.body;

        // Add uploader context
        const enrichedReports = reports.map(r => ({
            ...r,
            uploader: req.user._id
        }));

        const inserted = await Report.insertMany(enrichedReports);
        res.status(201).json({ message: `Successfully inserted ${inserted.length} records.`, count: inserted.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error inserting reports', error: error.message });
    }
});

// @desc    Get all reports (with optional date range filtering)
// @route   GET /api/reports
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

        if (req.user.role === 'POC') {
            query.uploader = req.user._id;
        } else if (uploader) {
            query.uploader = uploader;
        }

        const reports = await Report.find(query).populate('uploader', 'email');
        res.json(reports);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching reports', error: error.message });
    }
});

// @desc    Get daily KPI for POC
// @route   GET /api/reports/kpi
// @access  Private (POC)
router.get('/kpi', protect, async (req, res) => {
    try {
        const { date } = req.query;

        // Default to today
        const targetDate = date ? new Date(date) : new Date();
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const uploaderId = req.user.role === 'POC' ? req.user._id : undefined;

        let matchQuery = {
            createdAt: { $gte: startOfDay, $lte: endOfDay }
        };
        if (uploaderId) {
            matchQuery.uploader = uploaderId;
        }

        // Get all reports for the day
        const reports = await Report.find(matchQuery);

        const totalEndorsements = reports.length;
        const totalCompleted = reports.filter(r => r.status === 'Completed').length;
        const totalPending = reports.filter(r => r.status === 'Pending').length;
        const completionRate = totalEndorsements > 0
            ? Math.round((totalCompleted / totalEndorsements) * 100)
            : 0;

        // Average turnaround time (endorsement → completion) for completed reports
        const completedWithDates = reports.filter(r =>
            r.status === 'Completed' && r.endorsementDate && r.completionDate
        );
        let avgTurnaroundHours = 0;
        if (completedWithDates.length > 0) {
            const totalMs = completedWithDates.reduce((sum, r) => {
                return sum + (new Date(r.completionDate) - new Date(r.endorsementDate));
            }, 0);
            avgTurnaroundHours = Math.round((totalMs / completedWithDates.length) / (1000 * 60 * 60) * 10) / 10;
        }

        // Pending checks breakdown
        const pendingCheckCounts = {};
        const pendingReports = reports.filter(r => r.status === 'Pending');
        pendingReports.forEach(r => {
            if (r.checks) {
                for (const [key, val] of r.checks.entries()) {
                    if (val === 'Pending') {
                        pendingCheckCounts[key] = (pendingCheckCounts[key] || 0) + 1;
                    }
                }
            }
        });

        // Breakdown by account
        const accountBreakdown = {};
        reports.forEach(r => {
            const acct = r.account || 'Unknown';
            if (!accountBreakdown[acct]) {
                accountBreakdown[acct] = { total: 0, completed: 0, pending: 0 };
            }
            accountBreakdown[acct].total++;
            if (r.status === 'Completed') accountBreakdown[acct].completed++;
            else accountBreakdown[acct].pending++;
        });

        res.json({
            date: startOfDay.toISOString().substring(0, 10),
            totalEndorsements,
            totalCompleted,
            totalPending,
            completionRate,
            avgTurnaroundHours,
            pendingCheckCounts,
            accountBreakdown
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching KPI', error: error.message });
    }
});

// @desc    Get performance stats
// @route   GET /api/reports/stats
// @access  Private
router.get('/stats', protect, async (req, res) => {
    try {
        const { days } = req.query;
        const pastDays = days ? parseInt(days, 10) : 2;

        const dateLimit = new Date();
        dateLimit.setDate(dateLimit.getDate() - pastDays);

        let matchQuery = { createdAt: { $gte: dateLimit } };

        if (req.user.role === 'POC') {
            matchQuery.uploader = req.user._id;
        }

        // Aggregate by completed/pending
        const stats = await Report.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]);

        let totalCompleted = 0;
        let totalPending = 0;

        stats.forEach(stat => {
            if (stat._id === 'Completed') totalCompleted = stat.count;
            if (stat._id === 'Pending') totalPending = stat.count;
        });

        res.json({ totalCompleted, totalPending, pastDays });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching stats', error: error.message });
    }
});

export default router;
