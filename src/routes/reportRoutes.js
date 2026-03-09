import express from 'express';
import { protect, omOnly } from '../middleware/authMiddleware.js';
import Report from '../models/Report.js';
import KpiLog from '../models/KpiLog.js';
import Review from '../models/Review.js';

const router = express.Router();

// @desc    Batch insert parsed Excel reports
// @route   POST /api/reports/batch
// @access  Private
router.post('/batch', protect, async (req, res) => {
    try {
        const { reports } = req.body;

        if (!reports || !Array.isArray(reports)) {
            return res.status(400).json({ message: 'Invalid reports format' });
        }

        const uploaderId = req.user._id;
        const dateToday = new Date();
        dateToday.setHours(0, 0, 0, 0);

        let newRecordsCount = 0;
        let updatedRecordsCount = 0;
        let skippedCount = 0;

        for (const r of reports) {
            // Build lookup query
            let query = null;
            if (r.account && r.applicantName) {
                query = {
                    account: r.account,
                    applicantName: r.applicantName
                };
            } else if (r.account && r.endorsementDate) {
                query = {
                    account: r.account,
                    endorsementDate: r.endorsementDate,
                    applicantName: ''
                };
            }

            const existing = query ? await Report.findOne(query) : null;

            if (existing) {
                // --- Snapshot old values for comparison ---
                const oldValues = {};
                const fieldsToCheck = [
                    'endorsementDate', 'packageType', 'isCompleted', 'status', 'completionDate'
                ];
                for (const field of fieldsToCheck) {
                    oldValues[field] = existing[field] != null ? String(existing[field]) : '';
                }
                // Snapshot old checks as plain object
                const oldChecks = {};
                if (existing.checks) {
                    if (typeof existing.checks.forEach === 'function') {
                        existing.checks.forEach((val, key) => { oldChecks[key] = val; });
                    } else if (typeof existing.checks === 'object') {
                        Object.assign(oldChecks, existing.checks);
                    }
                }

                // --- Overwrite all fields with new values ---
                for (const field of fieldsToCheck) {
                    if (r[field] !== undefined) {
                        existing[field] = r[field];
                    }
                }
                // Overwrite checks entirely
                if (r.checks) {
                    existing.checks = new Map(Object.entries(r.checks));
                    existing.markModified('checks');
                }
                existing.uploader = uploaderId;

                // --- Detect what changed ---
                const changes = [];
                for (const field of fieldsToCheck) {
                    if (r[field] === undefined) continue;
                    const newVal = r[field] != null ? String(r[field]) : '';
                    if (oldValues[field] !== newVal) {
                        // Extra check for dates — compare by timestamp
                        if (field === 'endorsementDate' || field === 'completionDate') {
                            const oldTs = new Date(oldValues[field]).getTime();
                            const newTs = new Date(newVal).getTime();
                            if (!isNaN(oldTs) && !isNaN(newTs) && oldTs === newTs) continue;
                        }
                        changes.push({ field, from: oldValues[field], to: newVal });
                    }
                }
                // Detect check-level changes
                if (r.checks) {
                    const allKeys = new Set([...Object.keys(oldChecks), ...Object.keys(r.checks)]);
                    for (const key of allKeys) {
                        const oldVal = oldChecks[key] || '';
                        const newVal = r.checks[key] || '';
                        if (oldVal !== newVal) {
                            changes.push({ field: key, from: oldVal, to: newVal });
                        }
                    }
                }

                if (changes.length > 0) {
                    await existing.save();
                    updatedRecordsCount++;

                    // Log KPI with field-level changes
                    await KpiLog.findOneAndUpdate(
                        { poc: uploaderId, date: dateToday, reportId: existing._id },
                        { action: 'updated', changes },
                        { upsert: true }
                    );
                } else {
                    skippedCount++;
                }
            } else {
                // Insert new record
                const newReport = new Report({
                    ...r,
                    uploader: uploaderId
                });
                await newReport.save();
                newRecordsCount++;

                await KpiLog.findOneAndUpdate(
                    { poc: uploaderId, date: dateToday, reportId: newReport._id },
                    { $setOnInsert: { action: 'created', changes: [] } },
                    { upsert: true }
                );
            }
        }

        res.status(201).json({
            message: 'Batch upload successful',
            count: newRecordsCount + updatedRecordsCount,
            newRecords: newRecordsCount,
            updatedRecords: updatedRecordsCount,
            skipped: skippedCount
        });
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
            date: { $gte: startOfDay, $lte: endOfDay }
        };
        if (uploaderId) {
            matchQuery.poc = uploaderId;
        }

        // Get all KPI logs for the day and populate the associated report and POC user
        const kpiLogs = await KpiLog.find(matchQuery).populate('reportId').populate('poc', 'email role');

        // Extract the unique reports from the logs
        const reports = kpiLogs.map(log => log.reportId).filter(r => r != null);

        // Calculate explicit endorsements for today (created today + endorsement date matches today)
        const endorsementsToday = kpiLogs.filter(log => {
            if (log.action !== 'created' || !log.reportId) return false;
            const ed = new Date(log.reportId.endorsementDate);
            return ed >= startOfDay && ed <= endOfDay;
        }).length;

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

        // POC Breakdown for OM View
        const pocBreakdown = {};
        kpiLogs.forEach(log => {
            if (!log.poc || log.poc.role !== 'POC') return;
            const email = log.poc.email;
            if (!pocBreakdown[email]) {
                pocBreakdown[email] = {
                    endorsements: 0,
                    touches: 0,
                    completed: 0,
                    pending: 0,
                    updated: 0
                };
            }
            pocBreakdown[email].touches++;

            if (log.reportId) {
                if (log.reportId.status === 'Completed') {
                    pocBreakdown[email].completed++;
                } else if (log.reportId.status === 'Pending') {
                    pocBreakdown[email].pending++;
                }
            }

            // Count endorsements (new records with endorsement date matching the query date)
            if (log.action === 'created' && log.reportId) {
                const ed = new Date(log.reportId.endorsementDate);
                if (ed >= startOfDay && ed <= endOfDay) {
                    pocBreakdown[email].endorsements++;
                }
            }

            // Count updated records
            if (log.action === 'updated') {
                pocBreakdown[email].updated++;
            }
        });

        res.json({
            date: startOfDay.toISOString().substring(0, 10),
            endorsementsToday,
            totalEndorsements,
            totalCompleted,
            totalPending,
            completionRate,
            avgTurnaroundHours,
            pendingCheckCounts,
            accountBreakdown,
            pocBreakdown
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching KPI', error: error.message });
    }
});

// @desc    Get POC historical performance (last 7 days)
// @route   GET /api/reports/history
// @access  Private (POC)
router.get('/history', protect, async (req, res) => {
    try {
        const uploaderId = req.user._id;

        // Date range calculation (last 7 days)
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);

        const kpiLogs = await KpiLog.find({
            poc: uploaderId,
            date: { $gte: startDate, $lte: endDate }
        }).populate('reportId');

        // Group by Date DateString -> { date, total, completed, pending }
        const historyMap = {};

        // Initialize last 7 days to ensure empty days are shown
        for (let i = 0; i < 7; i++) {
            const d = new Date(endDate);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().substring(0, 10);
            historyMap[dateStr] = { date: dateStr, total: 0, completed: 0, pending: 0 };
        }

        kpiLogs.forEach(log => {
            const dateStr = new Date(log.date).toISOString().substring(0, 10);
            if (!historyMap[dateStr]) return; // Should not happen, but safeguard

            if (log.reportId) {
                historyMap[dateStr].total++;
                if (log.reportId.status === 'Completed') {
                    historyMap[dateStr].completed++;
                } else if (log.reportId.status === 'Pending') {
                    historyMap[dateStr].pending++;
                }
            }
        });

        const historyArray = Object.values(historyMap).sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(historyArray);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching POC history', error: error.message });
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

// @desc    Get field modification tally for POC KPI
// @route   GET /api/reports/modifications
// @access  Private (POC)
router.get('/modifications', protect, async (req, res) => {
    try {
        const { date } = req.query;

        const targetDate = date ? new Date(date) : new Date();
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const matchQuery = {
            date: { $gte: startOfDay, $lte: endOfDay },
            action: 'updated',
            'changes.0': { $exists: true }
        };

        if (req.user.role === 'POC') {
            matchQuery.poc = req.user._id;
        }

        const logs = await KpiLog.find(matchQuery)
            .populate('reportId', 'applicantName account')
            .populate('poc', 'email');

        // Build per-record change details
        const records = [];
        const fieldTally = {};

        for (const log of logs) {
            if (!log.reportId || !log.changes || log.changes.length === 0) continue;

            const entry = {
                applicantName: log.reportId.applicantName || 'N/A',
                account: log.reportId.account || 'N/A',
                changes: []
            };

            for (const c of log.changes) {
                entry.changes.push({
                    field: c.field,
                    from: c.from,
                    to: c.to
                });
                fieldTally[c.field] = (fieldTally[c.field] || 0) + 1;
            }

            records.push(entry);
        }

        res.json({ fieldTally, records });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching modifications', error: error.message });
    }
});

// @desc    Get TL reviews on POC's reports (for POC review panel)
// @route   GET /api/reports/my-reviews
// @access  Private (POC)
router.get('/my-reviews', protect, async (req, res) => {
    try {
        const { date } = req.query;

        // Get all reports belonging to this POC
        const reportQuery = { uploader: req.user._id };

        if (date) {
            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date);
            endOfDay.setHours(23, 59, 59, 999);
            reportQuery.endorsementDate = { $gte: startOfDay, $lte: endOfDay };
        }

        const reports = await Report.find(reportQuery).select('_id applicantName account status checks endorsementDate');
        const reportIds = reports.map(r => r._id);

        // Get all reviews for these reports
        const reviews = await Review.find({ reportId: { $in: reportIds } })
            .populate('reviewer', 'email')
            .sort({ createdAt: -1 });

        // Group reviews by report, attach report info
        const reportMap = {};
        reports.forEach(r => {
            reportMap[r._id.toString()] = r.toObject();
        });

        const flaggedReports = [];
        const reviewsByReport = {};

        reviews.forEach(rev => {
            const rid = rev.reportId.toString();
            if (!reviewsByReport[rid]) reviewsByReport[rid] = [];
            reviewsByReport[rid].push(rev);
        });

        // Build response: only include reports that have reviews with flags or remarks
        for (const [rid, revs] of Object.entries(reviewsByReport)) {
            const report = reportMap[rid];
            if (!report) continue;

            const hasFlags = revs.some(r => r.flaggedFields && r.flaggedFields.length > 0);
            const hasRemarks = revs.some(r => r.remarks && r.remarks.trim().length > 0);

            if (hasFlags || hasRemarks) {
                flaggedReports.push({
                    report,
                    reviews: revs.map(r => ({
                        reviewType: r.reviewType,
                        approved: r.approved,
                        flaggedFields: r.flaggedFields,
                        remarks: r.remarks,
                        reviewer: r.reviewer?.email || 'Unknown',
                        createdAt: r.createdAt
                    }))
                });
            }
        }

        // Daily flag summary
        const today = date ? new Date(date) : new Date();
        const dayStart = new Date(today);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(today);
        dayEnd.setHours(23, 59, 59, 999);

        const todayReviews = await Review.find({
            reportId: { $in: reportIds },
            createdAt: { $gte: dayStart, $lte: dayEnd }
        });

        const totalFlagsToday = todayReviews.reduce((sum, r) => sum + (r.flaggedFields?.length || 0), 0);
        const flagBreakdown = {};
        todayReviews.forEach(r => {
            (r.flaggedFields || []).forEach(f => {
                flagBreakdown[f] = (flagBreakdown[f] || 0) + 1;
            });
        });

        res.json({
            flaggedReports,
            totalFlagsToday,
            flagBreakdown
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching reviews', error: error.message });
    }
});

// @desc    Get distinct account names (for OM delete panel)
// @route   GET /api/reports/accounts
// @access  Private (OM)
router.get('/accounts', protect, omOnly, async (req, res) => {
    try {
        const accounts = await Report.distinct('account');
        // Return with count per account
        const accountCounts = [];
        for (const account of accounts) {
            const count = await Report.countDocuments({ account });
            accountCounts.push({ account, count });
        }
        accountCounts.sort((a, b) => a.account.localeCompare(b.account));
        res.json(accountCounts);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching accounts', error: error.message });
    }
});

// @desc    Delete reports by account name
// @route   DELETE /api/reports/by-account
// @access  Private (OM)
router.delete('/by-account', protect, omOnly, async (req, res) => {
    try {
        const { account } = req.body;
        if (!account) {
            return res.status(400).json({ message: 'Account name is required' });
        }

        // Find all report IDs for this account
        const reports = await Report.find({ account }).select('_id');
        const reportIds = reports.map(r => r._id);

        // Delete related KPI logs and reviews
        await KpiLog.deleteMany({ reportId: { $in: reportIds } });
        await Review.deleteMany({ reportId: { $in: reportIds } });

        // Delete the reports
        const result = await Report.deleteMany({ account });

        res.json({
            message: `Deleted ${result.deletedCount} report(s) for account "${account}"`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting reports', error: error.message });
    }
});

// @desc    Delete reports by date range (batch delete)
// @route   DELETE /api/reports/by-date
// @access  Private (OM)
router.delete('/by-date', protect, omOnly, async (req, res) => {
    try {
        const { startDate, endDate, account } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ message: 'startDate and endDate are required' });
        }

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const query = { endorsementDate: { $gte: start, $lte: end } };
        if (account) {
            query.account = account;
        }

        // Find all report IDs matching query
        const reports = await Report.find(query).select('_id');
        const reportIds = reports.map(r => r._id);

        // Delete related KPI logs and reviews
        await KpiLog.deleteMany({ reportId: { $in: reportIds } });
        await Review.deleteMany({ reportId: { $in: reportIds } });

        // Delete the reports
        const result = await Report.deleteMany(query);

        const label = account ? `account "${account}" from ${startDate} to ${endDate}` : `${startDate} to ${endDate}`;
        res.json({
            message: `Deleted ${result.deletedCount} report(s) for ${label}`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting reports', error: error.message });
    }
});

export default router;
