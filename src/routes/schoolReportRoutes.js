import express from 'express';
import SchoolReport from '../models/SchoolReport.js';
import SchoolKpiLog from '../models/SchoolKpiLog.js';
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

        const uploaderId = req.user._id;
        const dateToday = new Date();
        dateToday.setHours(0, 0, 0, 0);

        let newRecordsCount = 0;
        let updatedRecordsCount = 0;

        for (const r of reports) {
            // Find existing record by First, Last, and Middle Name
            const query = {
                firstName: r.firstName,
                lastName: r.lastName
            };

            if (r.middleName) {
                query.middleName = r.middleName;
            } else {
                query.middleName = { $in: [null, '', undefined] };
            }

            const existing = await SchoolReport.findOne(query);

            if (existing) {
                // Check if there are meaningful differences
                let hasChanges = false;
                const fieldsToCheck = [
                    'account', 'endorsementDate', 'schoolName', 'schoolAddress',
                    'degree', 'attainment', 'dateOfGraduation', 'remarks',
                    'sourceContact', 'resultDate', 'verifiedThru', 'status'
                ];

                for (const field of fieldsToCheck) {
                    if (r[field] !== undefined) {
                        const existingVal = existing[field] ? existing[field].toString() : '';
                        const newVal = r[field] ? r[field].toString() : '';

                        if (existingVal !== newVal) {
                            if (existing[field] instanceof Date || r[field] instanceof Date) {
                                const eDate = new Date(existing[field]).getTime();
                                const nDate = new Date(r[field]).getTime();
                                if (!isNaN(eDate) && !isNaN(nDate) && eDate !== nDate) {
                                    hasChanges = true;
                                    existing[field] = r[field];
                                } else if (isNaN(eDate) !== isNaN(nDate)) {
                                    hasChanges = true;
                                    existing[field] = r[field];
                                }
                            } else {
                                hasChanges = true;
                                existing[field] = r[field];
                            }
                        }
                    }
                }

                if (hasChanges) {
                    existing.uploader = uploaderId;
                    await existing.save();
                    updatedRecordsCount++;

                    // Log KPI update (upsert so we only log once a day per record)
                    await SchoolKpiLog.findOneAndUpdate(
                        { poc: uploaderId, date: dateToday, reportId: existing._id },
                        { $setOnInsert: { action: 'updated' } },
                        { upsert: true }
                    );
                }
            } else {
                // Insert new record
                const newReport = new SchoolReport({
                    ...r,
                    uploader: uploaderId
                });
                await newReport.save();
                newRecordsCount++;

                // Log KPI creation
                await SchoolKpiLog.findOneAndUpdate(
                    { poc: uploaderId, date: dateToday, reportId: newReport._id },
                    { $setOnInsert: { action: 'created' } },
                    { upsert: true }
                );
            }
        }

        res.status(201).json({
            message: 'Batch upload successful',
            count: newRecordsCount + updatedRecordsCount,
            newRecords: newRecordsCount,
            updatedRecords: updatedRecordsCount
        });
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
            date: { $gte: startOfDay, $lte: endOfDay }
        };
        if (uploaderId) {
            matchQuery.poc = uploaderId;
        }

        // Get all KPI logs for the day and populate the associated report and POC user
        const kpiLogs = await SchoolKpiLog.find(matchQuery).populate('reportId').populate('poc', 'email role');

        // Extract the unique reports from the logs
        const reports = kpiLogs.map(log => log.reportId).filter(r => r != null);

        // Calculate explicit endorsements for today (created today + endorsement date matches today)
        const endorsementsToday = kpiLogs.filter(log => {
            if (log.action !== 'created' || !log.reportId) return false;
            const ed = new Date(log.reportId.endorsementDate);
            return ed >= startOfDay && ed <= endOfDay;
        }).length;

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

        // Breakdown by POC (for OM)
        let pocBreakdown = undefined;
        if (!uploaderId) { // If OM
            pocBreakdown = {};
            kpiLogs.forEach(log => {
                if (!log.poc || log.poc.role !== 'POC-SCHOOL') return;
                const pocEmail = log.poc.email;
                if (!pocBreakdown[pocEmail]) {
                    pocBreakdown[pocEmail] = { total: 0, policy: 0, result: 0, closed: 0, pending: 0 };
                }
                pocBreakdown[pocEmail].total++;
                const r = log.reportId;
                if (r) {
                    if (r.status === 'policy') pocBreakdown[pocEmail].policy++;
                    else if (r.status === 'result') pocBreakdown[pocEmail].result++;
                    else if (r.status === 'closed thru internal') pocBreakdown[pocEmail].closed++;
                    else pocBreakdown[pocEmail].pending++;
                }
            });
        }

        res.json({
            date: startOfDay.toISOString().substring(0, 10),
            endorsementsToday,
            totalProcessed,
            totalPolicy,
            totalResult,
            totalClosed,
            totalPending,
            accountBreakdown,
            pocBreakdown
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching school KPI', error: error.message });
    }
});

// @desc    Get POC-SCHOOL historical performance (last 7 days)
// @route   GET /api/school-reports/history
// @access  Private (POC-SCHOOL)
router.get('/history', protect, async (req, res) => {
    try {
        const uploaderId = req.user._id;

        // Date range calculation (last 7 days)
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);

        const kpiLogs = await SchoolKpiLog.find({
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
            if (!historyMap[dateStr]) return; // Safeguard

            if (log.reportId) {
                historyMap[dateStr].total++;
                // In school reports, completed can be 'result', 'policy', 'closed thru internal'
                if (['result', 'policy', 'closed thru internal'].includes(log.reportId.status)) {
                    historyMap[dateStr].completed++;
                } else {
                    // Treating anything else, especially 'pending', as a pending touch
                    historyMap[dateStr].pending++;
                }
            }
        });

        const historyArray = Object.values(historyMap).sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(historyArray);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching School POC history', error: error.message });
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
