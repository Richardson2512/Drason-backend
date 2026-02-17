/**
 * Encryption Utilities
 *
 * Provides AES-256-GCM encryption for sensitive data like API keys
 */

import crypto from 'crypto';

// Encryption algorithm
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 64;
const KEY_LENGTH = 32; // 256 bits

/**
 * Get encryption key from environment or generate one
 * IMPORTANT: Set ENCRYPTION_KEY in environment variables for production
 */
function getEncryptionKey(): Buffer {
    const envKey = process.env.ENCRYPTION_KEY;

    if (!envKey) {
        console.warn('WARNING: ENCRYPTION_KEY not set in environment. Using default key. THIS IS INSECURE FOR PRODUCTION!');
        // Fallback key (NOT secure, for development only)
        return crypto.scryptSync('default-insecure-key-change-in-production', 'salt', KEY_LENGTH);
    }

    // Derive key from environment variable
    return crypto.scryptSync(envKey, 'fixed-salt', KEY_LENGTH);
}

/**
 * Encrypt a string value
 *
 * @param plaintext - The text to encrypt
 * @returns Encrypted text in format: iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Return format: iv:authTag:encrypted (all hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string
 *
 * @param encryptedData - The encrypted text in format: iv:authTag:encryptedData
 * @returns Decrypted plaintext
 */
export function decrypt(encryptedData: string): string {
    if (!encryptedData) return encryptedData;

    try {
        const key = getEncryptionKey();
        const parts = encryptedData.split(':');

        if (parts.length !== 3) {
            throw new Error('Invalid encrypted data format');
        }

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];

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
 * Check if a value is encrypted (has the expected format)
 */
export function isEncrypted(value: string): boolean {
    if (!value) return false;
    const parts = value.split(':');
    return parts.length === 3 && /^[0-9a-f]+$/i.test(parts[0]) && /^[0-9a-f]+$/i.test(parts[1]);
}

/**
 * Generate a secure random key for ENCRYPTION_KEY environment variable
 * Run this once and store in your .env file
 */
export function generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('hex');
}
