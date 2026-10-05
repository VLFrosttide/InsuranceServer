# Broker Pricing System

## Overview

The broker pricing system allows admins to view and edit pricing for each broker across different vehicle types and policy durations. This system is fully integrated into the admin dashboard's Brokers tab.

## Implementation Status

✅ **Endpoints Implemented**

- `GET /brokers/:brokerId/pricing` - Retrieve broker pricing
- `PUT /brokers/:brokerId/pricing` - Update broker pricing

Both endpoints are implemented in `Requests/Brokers.js` and require admin role (role = 1).

## API Endpoints

### GET /brokers/:brokerId/pricing

Retrieves all pricing for a specific broker.

**Authentication:** Required (Bearer token, admin role)

**Response:**

```json
{
  "success": true,
  "pricing": {
    "Auto": {
      "15": 25.0,
      "30": 45.0,
      "90": 120.0
    },
    "Motor": {
      "15": 20.0,
      "30": 38.0,
      "90": 100.0
    }
  }
}
```

**Error Responses:**

- `400`: Invalid broker ID
- `404`: Broker not found
- `500`: Database error

### PUT /brokers/:brokerId/pricing

Updates pricing for a specific broker.

**Authentication:** Required (Bearer token, admin role only)

**Request Body:**

```json
{
  "pricing": {
    "Auto": {
      "15": 25.5,
      "30": 45.5,
      "90": 120.5
    },
    "Motor": {
      "15": 20.5,
      "30": 38.5,
      "90": 100.5
    }
  }
}
```

**Response:**

```json
{
  "success": true,
  "message": "Pricing updated successfully",
  "pricing": {
    "Auto": {
      "15": 25.5,
      "30": 45.5,
      "90": 120.5
    }
  }
}
```

**Error Responses:**

- `400`: Invalid broker ID or pricing data format
- `403`: User is not admin
- `404`: Broker not found
- `500`: Database error

## Database Schema

### broker_pricing Table

```sql
CREATE TABLE IF NOT EXISTS broker_pricing (
  id INT PRIMARY KEY AUTO_INCREMENT,
  broker_id INT NOT NULL,
  vehicle_type VARCHAR(100) NOT NULL,
  duration INT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE,
  UNIQUE KEY unique_broker_vehicle_duration (broker_id, vehicle_type, duration),
  INDEX idx_broker_id (broker_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## Data Structure

Pricing data is organized by vehicle type and duration:

```javascript
{
  "vehicleType": {
    "duration": price,
    "15": 25.00,
    "30": 45.00,
    "90": 120.00
  }
}
```

Supported vehicle types: Auto, Motor, Bus, Trailer, etc.
Supported durations: 15, 30, 90 (days)

## Implementation Details

### GET Endpoint Logic (Requests/Brokers.js)

1. Validate broker ID
2. Check broker exists in database
3. Query pricing from broker_pricing table
4. Structure data as nested object
5. Return response

### PUT Endpoint Logic (Requests/Brokers.js)

1. Validate broker ID and pricing data
2. Check broker exists
3. Start database transaction
4. Delete existing pricing records
5. Insert new pricing records with validation
6. Commit transaction
7. Fetch and return updated pricing

### Key Features

- **Transaction Support**: Uses `DBConnection.withTransaction()` for atomic updates
- **Input Validation**: Validates vehicle types, durations, and prices
- **Error Handling**: Comprehensive error responses with appropriate HTTP status codes
- **Admin-Only**: Both endpoints require `requireAdmin` middleware (role = 1)

## Testing

### Test with curl

**Get pricing:**

```bash
curl -X GET "http://localhost:5501/brokers/1/pricing" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Update pricing:**

```bash
curl -X PUT "http://localhost:5501/brokers/1/pricing" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pricing": {
      "Auto": {"15": 26, "30": 46, "90": 121},
      "Motor": {"15": 21, "30": 39, "90": 101}
    }
  }'
```

## Frontend Integration

The frontend (InsuranceClient) calls these endpoints when:

1. Admin clicks "View/Edit Pricing" button on a broker row
2. Admin modifies prices in the modal
3. Admin clicks "Save" button

The frontend handles:

- Modal display and user interaction
- API calls with proper headers
- Error/success notifications
- Broker list refresh after update

See `BROKER_PRICING_API.md` in InsuranceClient for frontend specifications.

## Troubleshooting

### "Broker not found" (404)

- Verify the broker ID exists: `SELECT * FROM brokers WHERE id = ?`
- Check if broker was deleted

### "Invalid pricing data format" (400)

- Ensure pricing object contains vehicle type strings and duration objects
- Verify durations are objects with numeric keys as strings
- Check prices are valid numbers >= 0

### Database Transaction Errors

- Ensure broker_pricing table exists
- Check foreign key constraints
- Verify database connection is active

### Authorization Errors (403)

- Verify user role = 1 (admin)
- Check Bearer token is valid
- Ensure token hasn't expired
