// src/firebase.ts
import * as admin from 'firebase-admin';

let initialized = false;

export function initFirebase() {
    if (initialized) return admin;

    const projectId = process.env.FRBS_PROJECT_ID!;
    const clientEmail = process.env.FRBS_CLIENT_EMAIL!;
    const privateKey = process.env.FRBS_PRIVATE_KEY.replace(/\\n/g, '\n');
    const storageBucket = process.env.FRBS_STORAGEBUCKET!;

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
        }),
        storageBucket,
    });

    initialized = true;
    return admin;
}
