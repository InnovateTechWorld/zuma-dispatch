-- 0003: pay by bank transfer. Paystack's Charge API ("Pay with Transfer") issues a temporary
-- account number for the exact amount; we send those details straight into the WhatsApp chat.
ALTER TABLE payments ADD COLUMN method TEXT NOT NULL DEFAULT 'link' CHECK (method IN ('link', 'bank_transfer'));
ALTER TABLE payments ADD COLUMN transfer_bank TEXT;
ALTER TABLE payments ADD COLUMN transfer_account_number TEXT;
ALTER TABLE payments ADD COLUMN transfer_account_name TEXT;
ALTER TABLE payments ADD COLUMN transfer_expires_at INTEGER;
