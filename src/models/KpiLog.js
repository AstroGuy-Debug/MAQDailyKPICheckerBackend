import mongoose from 'mongoose';

const kpiLogSchema = new mongoose.Schema({
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
        ref: 'Report',
        required: true
    },
    action: {
        type: String,
        enum: ['created', 'updated'],
        required: true
    },
    changes: [{
        field: String,
        from: String,
        to: String
    }]
}, { timestamps: true });

export default mongoose.model('KpiLog', kpiLogSchema);
