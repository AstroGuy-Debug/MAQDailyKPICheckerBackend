import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema({
    reportId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Report',
        required: true
    },
    reviewer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reviewType: {
        type: String,
        enum: ['initial', 'final'],
        required: true
    },
    approved: {
        type: Boolean,
        default: false
    },
    flaggedFields: [{
        type: String
    }],
    remarks: {
        type: String,
        default: ''
    }
}, { timestamps: true });

export default mongoose.model('Review', reviewSchema);
