import mongoose from 'mongoose';

const schoolKpiLogSchema = new mongoose.Schema({
    poc: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    reportId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SchoolReport',
        required: true
    },
    action: {
        type: String,
        enum: ['created', 'updated'],
        required: true
    }
}, { timestamps: true });

// Prevent duplicate logs for the same report on the same day by the same POC
// Although multiple updates in a day could happen, usually one 'touch' per day is counted.
// We can just log all touches or enforce uniqueness if we strictly want 1 log per report per day.
// For now, let's keep it simple and just log all touches, then count unique reports modified per day.

export default mongoose.model('SchoolKpiLog', schoolKpiLogSchema);
