/**
 * Encryption Utilities
 *
 * Provides AES-256-GCM encryption for sensitive data like API keys.
 * Uses per-operation random salt for key derivation.
 *
 * Format (v2): salt:iv:authTag:encryptedData (4 hex-encoded parts)
 * Legacy (v1): iv:authTag:encryptedData (3 hex-encoded parts, fixed salt)
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

// Legacy salt used in v1 format — only for decrypting old data
const LEGACY_FIXED_SALT = 'fixed-salt';

/**
 * Derive encryption key from env var + salt.
 * Throws if ENCRYPTION_KEY is not set.
 */
function deriveKey(salt: string | Buffer): Buffer {
    const envKey = process.env.ENCRYPTION_KEY;
    if (!envKey) {
        throw new Error(
            'ENCRYPTION_KEY environment variable is required. ' +
            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        );
    }
    return crypto.scryptSync(envKey, salt, KEY_LENGTH);
}

/**
 * Encrypt a string value.
 *
 * @param plaintext - The text to encrypt
 * @returns Encrypted text in format: salt:iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // v2 format: salt:iv:authTag:encrypted
    return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string. Supports both v2 (random salt) and v1 (fixed salt) formats.
 *
 * @param encryptedData - The encrypted text (v2: salt:iv:authTag:data, v1: iv:authTag:data)
 * @returns Decrypted plaintext
 */
export function decrypt(encryptedData: string): string {
    if (!encryptedData) return encryptedData;

    try {
        const parts = encryptedData.split(':');

        let salt: string | Buffer;
        let ivHex: string;
        let authTagHex: string;
        let encrypted: string;

        if (parts.length === 4) {
            // v2 format: salt:iv:authTag:encrypted
            salt = Buffer.from(parts[0], 'hex');
            ivHex = parts[1];
            authTagHex = parts[2];
            encrypted = parts[3];
        } else if (parts.length === 3) {
            // v1 legacy format: iv:authTag:encrypted (used fixed salt)
            salt = LEGACY_FIXED_SALT;
            ivHex = parts[0];
            authTagHex = parts[1];
            encrypted = parts[2];
        } else {
            throw new Error('Invalid encrypted data format');
        }

        const key = deriveKey(salt);
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error: any) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

/**
 * Check if a value is encrypted (has the expected format — v1 or v2)
 */
export function isEncrypted(value: string): boolean {
    if (!value) return false;
    const parts = value.split(':');
    // v2: 4 parts (salt:iv:authTag:data), v1: 3 parts (iv:authTag:data)
    if (parts.length !== 3 && parts.length !== 4) return false;
    return parts.every(p => /^[0-9a-f]+$/i.test(p));
}

/**
 * Generate a secure random key for ENCRYPTION_KEY environment variable.
 * Run this once and store in your .env file.
 */
export function generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('hex');
}
