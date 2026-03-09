import express from 'express';
import { protect, tlOnly, tlOrOm } from '../middleware/authMiddleware.js';
import Review from '../models/Review.js';
import Report from '../models/Report.js';
import User from '../models/User.js';
import KpiLog from '../models/KpiLog.js';

const router = express.Router();

// @desc    Get team members (POCs assigned to this TL)
// @route   GET /api/tl/team
// @access  Private (TL)
router.get('/team', protect, tlOnly, async (req, res) => {
    try {
        const members = await User.find({ teamLeader: req.user._id })
            .select('email role isVerified createdAt');
        res.json(members);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching team', error: error.message });
    }
});

// @desc    Get reports from team members (with optional date filter)
// @route   GET /api/tl/reports
// @access  Private (TL)
router.get('/reports', protect, tlOnly, async (req, res) => {
    try {
        const { startDate, endDate, memberId } = req.query;

        // Get all team member IDs
        const memberQuery = { teamLeader: req.user._id };
        const members = await User.find(memberQuery).select('_id');
        const memberIds = members.map(m => m._id);

        // Also include TL's own reports
        memberIds.push(req.user._id);

        let query = { uploader: memberId ? memberId : { $in: memberIds } };

        if (startDate && endDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            query.endorsementDate = { $gte: start, $lte: end };
        }

        const reports = await Report.find(query)
            .populate('uploader', 'email role')
            .sort({ createdAt: -1 });

        // Attach latest review info to each report
        const reportIds = reports.map(r => r._id);
        const reviews = await Review.find({ reportId: { $in: reportIds } })
            .sort({ createdAt: -1 });

        const reviewMap = {};
        reviews.forEach(rev => {
            const key = rev.reportId.toString();
            if (!reviewMap[key]) reviewMap[key] = {};
            if (!reviewMap[key][rev.reviewType]) {
                reviewMap[key][rev.reviewType] = rev;
            }
        });

        const enriched = reports.map(r => {
            const rObj = r.toObject();
            const rid = r._id.toString();
            rObj.initialReview = reviewMap[rid]?.initial || null;
            rObj.finalReview = reviewMap[rid]?.final || null;
            return rObj;
        });

        res.json(enriched);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching reports', error: error.message });
    }
});

// @desc    Submit a review (initial or final)
// @route   POST /api/tl/review
// @access  Private (TL)
router.post('/review', protect, tlOnly, async (req, res) => {
    try {
        const { reportId, reviewType, approved, flaggedFields, remarks } = req.body;

        if (!reportId || !reviewType) {
            return res.status(400).json({ message: 'reportId and reviewType are required' });
        }

        if (!['initial', 'final'].includes(reviewType)) {
            return res.status(400).json({ message: 'reviewType must be initial or final' });
        }

        const report = await Report.findById(reportId);
        if (!report) {
            return res.status(404).json({ message: 'Report not found' });
        }

        // Create or update review for this report + type combo
        const review = await Review.findOneAndUpdate(
            { reportId, reviewer: req.user._id, reviewType },
            {
                approved: approved || false,
                flaggedFields: flaggedFields || [],
                remarks: remarks || ''
            },
            { upsert: true, new: true }
        );

        // If final review is approved, mark report as completed with today's date
        if (reviewType === 'final' && approved) {
            report.isCompleted = true;
            report.status = 'Completed';
            report.completionDate = new Date();
            report.markModified('checks');
            await report.save();

            // Log KPI for the POC whose report was completed
            const dateToday = new Date();
            dateToday.setHours(0, 0, 0, 0);
            await KpiLog.findOneAndUpdate(
                { poc: report.uploader, date: dateToday, reportId: report._id },
                { action: 'updated', changes: [{ field: 'status', from: 'Pending', to: 'Completed' }] },
                { upsert: true }
            );
        }

        res.json({
            message: `${reviewType} review saved`,
            review,
            reportCompleted: reviewType === 'final' && approved
        });
    } catch (error) {
        res.status(500).json({ message: 'Error saving review', error: error.message });
    }
});

// @desc    Get reviews for a specific report
// @route   GET /api/tl/review/:reportId
// @access  Private (TL or POC owner)
router.get('/review/:reportId', protect, async (req, res) => {
    try {
        const reviews = await Review.find({ reportId: req.params.reportId })
            .populate('reviewer', 'email')
            .sort({ createdAt: -1 });
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching reviews', error: error.message });
    }
});

// @desc    TL KPI — reviews done, flags, team stats
// @route   GET /api/tl/kpi
// @access  Private (TL)
router.get('/kpi', protect, tlOnly, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        // Get team members
        const members = await User.find({ teamLeader: req.user._id }).select('_id email');
        const memberIds = members.map(m => m._id);
        memberIds.push(req.user._id); // include TL themselves

        // Reviews done by TL today
        const reviewsToday = await Review.find({
            reviewer: req.user._id,
            createdAt: { $gte: startOfDay, $lte: endOfDay }
        }).populate('reportId', 'applicantName account uploader');

        const initialReviews = reviewsToday.filter(r => r.reviewType === 'initial');
        const finalReviews = reviewsToday.filter(r => r.reviewType === 'final');
        const approvedFinal = finalReviews.filter(r => r.approved);
        const totalFlagged = reviewsToday.reduce((sum, r) => sum + (r.flaggedFields?.length || 0), 0);

        // Field flag breakdown
        const flagBreakdown = {};
        reviewsToday.forEach(r => {
            (r.flaggedFields || []).forEach(f => {
                flagBreakdown[f] = (flagBreakdown[f] || 0) + 1;
            });
        });

        // Team KPI — reports uploaded/updated per member today
        const teamKpi = {};
        for (const member of members) {
            const logs = await KpiLog.find({
                poc: member._id,
                date: { $gte: startOfDay, $lte: endOfDay }
            }).populate('reportId');

            const reports = logs.map(l => l.reportId).filter(Boolean);
            const created = logs.filter(l => l.action === 'created').length;
            const updated = logs.filter(l => l.action === 'updated').length;
            const completed = reports.filter(r => r.status === 'Completed').length;
            const pending = reports.filter(r => r.status === 'Pending').length;

            teamKpi[member.email] = {
                touches: reports.length,
                created,
                updated,
                completed,
                pending
            };
        }

        // TL's own work
        const tlLogs = await KpiLog.find({
            poc: req.user._id,
            date: { $gte: startOfDay, $lte: endOfDay }
        }).populate('reportId');
        const tlReports = tlLogs.map(l => l.reportId).filter(Boolean);

        res.json({
            date: startOfDay.toISOString().substring(0, 10),
            reviewsToday: {
                total: reviewsToday.length,
                initial: initialReviews.length,
                final: finalReviews.length,
                approvedFinal: approvedFinal.length,
                totalFlagged
            },
            flagBreakdown,
            teamKpi,
            tlWork: {
                touches: tlReports.length,
                created: tlLogs.filter(l => l.action === 'created').length,
                updated: tlLogs.filter(l => l.action === 'updated').length,
                completed: tlReports.filter(r => r.status === 'Completed').length,
                pending: tlReports.filter(r => r.status === 'Pending').length
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching TL KPI', error: error.message });
    }
});

// @desc    Get review KPI for a specific TL (OM view)
// @route   GET /api/tl/review-kpi/:tlId
// @access  Private (OM)
router.get('/review-kpi/:tlId', protect, tlOrOm, async (req, res) => {
    try {
        const { date } = req.query;
        const tlId = req.params.tlId;

        // Verify the target user is a TL
        const tlUser = await User.findById(tlId).select('email role');
        if (!tlUser || (tlUser.role !== 'TL' && tlUser.role !== 'TL-SCHOOL')) {
            return res.status(404).json({ message: 'TL not found' });
        }

        const targetDate = date ? new Date(date) : new Date();
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        // Reviews done by this TL on the target date
        const reviewsToday = await Review.find({
            reviewer: tlId,
            createdAt: { $gte: startOfDay, $lte: endOfDay }
        }).populate('reportId', 'applicantName account uploader');

        const initialReviews = reviewsToday.filter(r => r.reviewType === 'initial');
        const finalReviews = reviewsToday.filter(r => r.reviewType === 'final');
        const approvedFinal = finalReviews.filter(r => r.approved);
        const rejectedFinal = finalReviews.filter(r => !r.approved);
        const totalFlagged = reviewsToday.reduce((sum, r) => sum + (r.flaggedFields?.length || 0), 0);

        // Flag breakdown
        const flagBreakdown = {};
        reviewsToday.forEach(r => {
            (r.flaggedFields || []).forEach(f => {
                flagBreakdown[f] = (flagBreakdown[f] || 0) + 1;
            });
        });

        // Team members under this TL
        const members = await User.find({ teamLeader: tlId }).select('_id email');

        // Team KPI
        const teamKpi = {};
        for (const member of members) {
            const logs = await KpiLog.find({
                poc: member._id,
                date: { $gte: startOfDay, $lte: endOfDay }
            }).populate('reportId');

            const reports = logs.map(l => l.reportId).filter(Boolean);
            teamKpi[member.email] = {
                touches: reports.length,
                created: logs.filter(l => l.action === 'created').length,
                updated: logs.filter(l => l.action === 'updated').length,
                completed: reports.filter(r => r.status === 'Completed').length,
                pending: reports.filter(r => r.status === 'Pending').length
            };
        }

        res.json({
            tlEmail: tlUser.email,
            date: startOfDay.toISOString().substring(0, 10),
            reviewsToday: {
                total: reviewsToday.length,
                initial: initialReviews.length,
                final: finalReviews.length,
                approvedFinal: approvedFinal.length,
                rejectedFinal: rejectedFinal.length,
                totalFlagged
            },
            flagBreakdown,
            teamKpi,
            teamSize: members.length
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching TL review KPI', error: error.message });
    }
});

export default router;
