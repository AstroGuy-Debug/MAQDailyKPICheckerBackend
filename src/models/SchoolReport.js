import mongoose from 'mongoose';

const schoolReportSchema = new mongoose.Schema({
    account: { type: String, required: true },
    endorsementDate: { type: Date, required: true },
    lastName: { type: String, required: true },
    firstName: { type: String, required: true },
    middleName: { type: String },
    schoolName: { type: String },
    schoolAddress: { type: String },
    degree: { type: String },
    attainment: { type: String },
    dateOfGraduation: { type: String },
    remarks: { type: String },
    sourceContact: { type: String },
    resultDate: { type: Date },
    verifiedThru: { type: String },
    status: {
        type: String,
        enum: ['policy', 'result', 'closed thru internal', 'pending'],
        default: 'pending'
    },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export default mongoose.model('SchoolReport', schoolReportSchema);
