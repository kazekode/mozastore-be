import mongoose from "mongoose";

const paymentGatewaySettingSchema = new mongoose.Schema({
    gateway_name: { type: String, required: true, unique: true },
    is_active: { type: Boolean, default: false },
    settings: { type: Object, default: {} }
}, { timestamps: true });

export const PaymentGatewaySetting = mongoose.model('PaymentGatewaySetting', paymentGatewaySettingSchema);

const smtpSettingSchema = new mongoose.Schema({
    email: { type: String, required: true },
    password: { type: String, required: true },
    host: { type: String, default: 'smtp.gmail.com' },
    port: { type: Number, default: 465 },
    secure: { type: Boolean, default: true }
}, { timestamps: true });

export const SmtpSetting = mongoose.model('SmtpSetting', smtpSettingSchema);
