# backend/services/auth_helpers.py

import os
import firebase_admin
from firebase_admin import auth, credentials
from flask import request

# Step 1: Initialize Firebase Admin SDK (run only once)
# Put your downloaded json key inside your backend folder at: ./secrets/firebase-service-account.json
FIREBASE_KEY_PATH = os.getenv('FIREBASE_KEY_PATH', 'secrets/firebase-service-account.json')

if not firebase_admin._apps:
    cred = credentials.Certificate(FIREBASE_KEY_PATH)
    firebase_admin.initialize_app(cred)

def get_firebase_uid_from_request():
    """
    Gets the Firebase UID from the Authorization Bearer token header.
    Returns user's UID if token is valid, else None.
    """
    auth_header = request.headers.get('Authorization', None)
    if not auth_header or not auth_header.startswith('Bearer '):
        return None

    id_token = auth_header.split('Bearer ')[1].strip()
    try:
        decoded_token = auth.verify_id_token(id_token)
        return decoded_token.get('uid')
    except Exception as e:
        print(f"Firebase token verification failed: {e}")
        return None

def get_firebase_email_from_request():
    """
    Gets the user's email from token, if available. Optional for audit logging.
    """
    auth_header = request.headers.get('Authorization', None)
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    id_token = auth_header.split('Bearer ')[1].strip()
    try:
        decoded_token = auth.verify_id_token(id_token)
        return decoded_token.get('email')
    except Exception as e:
        print(f"Firebase token verification failed: {e}")
        return None
