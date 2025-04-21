# Project Unmessy - Email Validation

Project Unmessy is a service that helps clean and validate email addresses for CRM systems, particularly HubSpot. It focuses on making data cleanliness "idiot-proof" by providing simple checks and predictable results.

## Features

- Email format validation
- Common typo correction
- Domain validation
- Integration with ZeroBounce API for deeper validation
- HubSpot webhook integration for automatic contact updates
- Caching of known valid emails in Upstash Redis
- Batch validation support

## Architecture

The project consists of several components:

1. **Email Validation Service** - Core service that handles all validation logic
2. **API Endpoints** - REST endpoints for validation and HubSpot integration
3. **Upstash Redis** - For caching known valid emails to reduce API calls
4. **HubSpot Integration** - Webhooks and API for contact updates

## Setup Instructions

### Prerequisites

- Node.js (v14 or higher)
- Upstash Redis account
- ZeroBounce API key (optional)
- HubSpot API key and client secret (for HubSpot integration)

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and update the values:
   ```
   cp .env.example .env
   ```
4. Update your environment variables:
   - `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` from your Upstash dashboard
   - `ZERO_BOUNCE_API_KEY` if you plan to use ZeroBounce
   - `HUBSPOT_API_KEY` and `HUBSPOT_CLIENT_SECRET` for HubSpot integration

### Development

Run the development server:

```
npm run dev
```

### Deployment

The project is set up for deployment on Vercel. Simply connect your repository to Vercel and ensure all environment variables are set.

## API Endpoints

### Validate Single Email

**POST /api/validate/email**

Request body:
```json
{
  "email": "example@domain.com"
}
```

### Validate Batch of Emails

**POST /api/validate/batch**

Request body:
```json
{
  "emails": ["example1@domain.com", "example2@domain.com"]
}
```

### HubSpot Webhook

**POST /api/webhooks/hubspot**

This endpoint is for HubSpot to call when contact events occur.

## HubSpot Setup

To integrate with HubSpot:

1. Create custom properties in HubSpot:
   - `email_status` (enumeration: valid, invalid, unknown, check_failed)
   - `email_sub_status` (single-line text)
   - `email_recheck_needed` (boolean)
   - `email_check_date` (date)
   - `email_corrected` (boolean)
   - `original_email` (single-line text)

2. Create a webhook subscription in HubSpot that points to your `/api/webhooks/hubspot` endpoint for:
   - Contact creation
   - Email property changes
   - Contact merges

## Architecture Diagram

```
┌─────────────┐          ┌───────────────────────┐          ┌──────────────┐
│             │          │                       │          │              │
│   HubSpot   │◄────────►│  Unmessy Middleware   │◄────────►│  Upstash Redis │
│             │          │                       │          │              │
└─────────────┘          └───────────────────────┘          └──────────────┘
                                    ▲
                                    │
                                    ▼
                          ┌──────────────────┐
                          │                  │
                          │  ZeroBounce API  │
                          │                  │
                          └──────────────────┘
```

## License

Private, proprietary software.