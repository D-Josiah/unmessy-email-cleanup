// Save validation result to Supabase with deduplication
async saveValidationResult(originalEmail, validationResult, clientId = null) {
  if (!this.supabaseEnabled || !this.supabase) {
    console.log('SUPABASE_SAVE: Supabase not enabled, skipping save', {
      supabaseEnabled: this.supabaseEnabled,
      supabaseClientExists: !!this.supabase,
      connectionStatus: this.supabaseConnectionStatus
    });
    return { success: false, reason: 'Supabase not enabled' };
  }

  // First, check our connection status and test if needed
  if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
    try {
      console.log('SUPABASE_SAVE: Testing connection before save attempt');
      await this._testSupabaseConnectionAsync();
      
      // If the test succeeded but we still don't have a connected status, wait briefly
      if (this.supabaseConnectionStatus === 'connected') {
        console.log('SUPABASE_SAVE: Connection test successful, proceeding with save');
      } else {
        console.log('SUPABASE_SAVE: Connection test did not result in connected status', {
          status: this.supabaseConnectionStatus
        });
        return { success: false, reason: 'Connection test failed' };
      }
    } catch (error) {
      console.error('SUPABASE_SAVE: Connection test failed', { error: error.message });
      return { success: false, reason: 'Connection test error: ' + error.message };
    }
  }
  
  // Only proceed if we have a confirmed connection
  if (this.supabaseConnectionStatus !== 'connected') {
    console.log('SUPABASE_SAVE: Skipping save due to connection status', {
      connectionStatus: this.supabaseConnectionStatus
    });
    return { success: false, reason: 'Supabase not connected' };
  }

  try {
    console.log('SUPABASE_SAVE: Starting save operation for email', { 
      email: originalEmail,
      clientId: clientId || 'default'
    });
    
    // First, check if this email already exists in the database
    console.log('SUPABASE_SAVE: Checking if email already exists in database');
    
    try {
      const { data: existingRecord, error: checkError } = await this.supabase
        .from('email_validations')
        .select('id, email, um_email, contact_id, um_email_status, um_bounce_status, date_last_um_check, date_last_um_check_epoch, um_check_id')
        .eq('email', originalEmail)
        .order('date_last_um_check_epoch', { ascending: false })
        .limit(1);
      
      if (checkError) {
        console.error('SUPABASE_SAVE_ERROR: Failed to check for existing record', {
          error: checkError.message,
          code: checkError.code
        });
<<<<<<< HEAD
        this.supabaseConnectionStatus = 'error';
      }
    }
    
    // Timeouts configuration with defaults
    this.timeouts = {
      supabase: config.timeouts?.supabase || 8000,
      zeroBounce: config.timeouts?.zeroBounce || 4000,
      hubspot: config.timeouts?.hubspot || 5000,
      validation: config.timeouts?.validation || 4000, 
      webhook: config.timeouts?.webhook || 6000
    };

    // Common email domain typos
    this.domainTypos = {
      'gmial.com': 'gmail.com',
      'gmal.com': 'gmail.com',
      'gmail.cm': 'gmail.com',
      'gmail.co': 'gmail.com',
      'gamil.com': 'gmail.com',
      'hotmial.com': 'hotmail.com',
      'hotmail.cm': 'hotmail.com',
      'yahoo.cm': 'yahoo.com',
      'yaho.com': 'yahoo.com',
      'outlook.cm': 'outlook.com',
      'outlok.com': 'outlook.com'
    };
    
    this.australianTlds = ['.com.au', '.net.au', '.org.au', '.edu.au', '.gov.au', '.asn.au', '.id.au', '.au'];
    
    // Extended list of common domains for local validation
    this.commonValidDomains = [
      'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 
      'aol.com', 'protonmail.com', 'fastmail.com', 'mail.com', 'zoho.com',
      'yandex.com', 'gmx.com', 'live.com', 'msn.com', 'me.com', 'mac.com', 
      'googlemail.com', 'pm.me', 'tutanota.com', 'mailbox.org'
    ];
    
    // Client ID for um_check_id generation
    this.clientId = config.clientId || '00001';
    this.umessyVersion = config.umessyVersion || '100';
  }

  // Asynchronous test without blocking operations
  async _testSupabaseConnectionAsync() {
    if (!this.supabase) {
      console.log('SUPABASE_CONNECTION_TEST: No Supabase client initialized');
      this.supabaseConnectionStatus = 'disabled';
      return;
    }
    
    try {
      console.log('SUPABASE_CONNECTION_TEST: Attempting to connect to Supabase...');
      
      // Simpler approach without abort controller for more reliable connection
      try {
        // Make a simple query that's fast - just check if the table exists
        const { data, error } = await this.supabase
          .from('contacts')
          .select('id')
          .limit(1);
        
        if (error) {
          console.error('SUPABASE_CONNECTION_FAILED:', { 
            message: error.message,
            code: error.code,
            details: error.details
          });
          this.supabaseConnectionStatus = 'failed';
          return;
        }
        
        // Connection successful
        console.log('SUPABASE_CONNECTION_SUCCESSFUL: Successfully connected to Supabase database', {
          tableName: 'contacts',
          approximateRowCount: data ? data.length : 0
        });
        this.supabaseConnectionStatus = 'connected';
      } catch (innerError) {
        throw innerError;
      }
    } catch (error) {
      console.error('SUPABASE_CONNECTION_TEST_ERROR:', { 
        message: error.message,
        stack: error.stack
      });
      this.supabaseConnectionStatus = 'error';
    }
  }

  // Generic timeout wrapper with AbortController
  async withTimeout(promiseFn, timeoutMs, errorMessage = 'Operation timeout') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      // Execute the function with the abort signal
      const result = await promiseFn(controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }
  
  // Generate um_check_id based on specification
  generateUmCheckId(customClientId = null) {
    const epochTime = Math.floor(Date.now() / 1000);
    const lastSixDigits = String(epochTime).slice(-6);
    
    // Use provided client ID or default
    const clientId = customClientId || this.clientId;
    
    // Calculate check digit
    const firstThreeDigits = String(epochTime).slice(0, 3);
    const sum = [...firstThreeDigits].reduce((acc, digit) => acc + parseInt(digit), 0);
    const checkDigit = String(sum * parseInt(clientId)).padStart(3, '0');
    
    // Format: lastSixDigits + clientId + checkDigit + version
    return `${lastSixDigits}${clientId}${checkDigit}${this.umessyVersion}`;
  }
  
  // Non-blocking Supabase check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return { found: false };
    }

    try {
      // Use AbortController and timeout
      const result = await this.withTimeout(
        async (signal) => {
          console.log('SUPABASE_CHECK: Attempting to check if email exists in Supabase', { email });
          
          const { data, error } = await this.supabase
            .from('email_validations')
            .select('email, um_email_status')
            .eq('email', email)
            .abortSignal(signal)
            .single();
          
          if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows returned" error
            throw error;
          }
          
          const found = !!data;
          console.log('SUPABASE_CHECK: Completed successfully', { 
            email, 
            found, 
            status: data?.um_email_status || null
          });
          
          return {
            found,
            data
          };
        },
        this.timeouts.supabase,
        'Supabase check timeout'
      );
      
      if (result.found) {
        console.log('SUPABASE_CHECK: Email found in Supabase database', { email });
      } else {
        console.log('SUPABASE_CHECK: Email not found in Supabase database', { email });
      }
      
      return result;
    } catch (error) {
      console.error('SUPABASE_GET_ERROR:', { message: error.message, email });
      return { found: false }; // Continue validation on failure
    }
  }
  
  // Save validation result to Supabase with improved reliability and check existing
  async saveValidationResult(originalEmail, validationResult, clientId = null) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_SAVE: Supabase not enabled, skipping save', {
        supabaseEnabled: this.supabaseEnabled,
        supabaseClientExists: !!this.supabase,
        connectionStatus: this.supabaseConnectionStatus
      });
      return { success: false, reason: 'Supabase not enabled' };
    }

    // First, check our connection status and test if needed
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('SUPABASE_SAVE: Testing connection before save attempt');
        await this._testSupabaseConnectionAsync();
        
        // If the test succeeded but we still don't have a connected status, wait briefly
        if (this.supabaseConnectionStatus === 'connected') {
          console.log('SUPABASE_SAVE: Connection test successful, proceeding with save');
        } else {
          console.log('SUPABASE_SAVE: Connection test did not result in connected status', {
            status: this.supabaseConnectionStatus
          });
          return { success: false, reason: 'Connection test failed' };
        }
      } catch (error) {
        console.error('SUPABASE_SAVE: Connection test failed', { error: error.message });
        return { success: false, reason: 'Connection test error: ' + error.message };
      }
    }
    
    // Only proceed if we have a confirmed connection
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('SUPABASE_SAVE: Skipping save due to connection status', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return { success: false, reason: 'Supabase not connected' };
    }

    try {
      console.log('SUPABASE_SAVE: Starting save operation for email', { 
        email: originalEmail,
        clientId: clientId || 'default'
      });
      
      // Create a check ID for this validation if not already present
      const umCheckId = validationResult.um_check_id || this.generateUmCheckId(clientId);
      const now = new Date();
      
      // Map validation status to um_email_status and um_bounce_status
      let umEmailStatus = validationResult.um_email_status || 'Unable to change';
      let umBounceStatus = validationResult.um_bounce_status || 'Unknown';
      
      if (!validationResult.um_email_status) {
        if (validationResult.wasCorrected) {
          umEmailStatus = 'Changed';
        } else {
          umEmailStatus = 'Unchanged';
        }
      }
      
      if (!validationResult.um_bounce_status) {
        if (validationResult.status === 'valid') {
          umBounceStatus = 'Unlikely to bounce';
        } else if (validationResult.status === 'invalid') {
          umBounceStatus = 'Likely to bounce';
        }
      }
      
      // First, check if the email already exists in the database
      console.log('SUPABASE_SAVE: Checking if email already exists in database', { email: originalEmail });
      
      const { data: existingRecord, error: searchError } = await this.supabase
        .from('email_validations')
        .select('id, contact_id')
        .eq('email', originalEmail)
        .maybeSingle();
        
      if (searchError && searchError.code !== 'PGRST116') { // PGRST116 is "No rows returned" error
        console.error('SUPABASE_SAVE_ERROR: Error searching for existing record', {
          error: searchError.message,
          code: searchError.code
        });
        throw new Error(`Failed to search for existing record: ${searchError.message}`);
      }
      
      // If email exists, update the existing record
      if (existingRecord) {
        console.log('SUPABASE_SAVE: Email found in database, updating existing record', {
          email: originalEmail,
          recordId: existingRecord.id,
          contactId: existingRecord.contact_id
        });
        
        // Prepare update data
        const updateData = {
          date_last_um_check: validationResult.date_last_um_check || now.toISOString(),
          date_last_um_check_epoch: validationResult.date_last_um_check_epoch || Math.floor(now.getTime() / 1000),
          um_check_id: umCheckId,
          um_email: validationResult.currentEmail || validationResult.um_email || originalEmail,
          um_email_status: umEmailStatus,
          um_bounce_status: umBounceStatus,
          client_id: clientId || null // Store the client ID that requested this validation
        };
        
        // Update the existing record
        const { data: updatedRecord, error: updateError } = await this.supabase
          .from('email_validations')
          .update(updateData)
          .eq('id', existingRecord.id)
          .select()
          .single();
          
        if (updateError) {
          console.error('SUPABASE_SAVE_ERROR: Failed to update existing record', {
            error: updateError.message,
            code: updateError.code
          });
          throw new Error(`Failed to update existing record: ${updateError.message}`);
        }
        
        console.log('SUPABASE_SAVE: Successfully updated existing record', {
          email: originalEmail,
          operation: 'update',
          id: updatedRecord.id,
          clientId: clientId || 'default'
        });
        
        return { success: true, operation: 'update', data: updatedRecord };
      }
      
      // If email doesn't exist, create a new contact and validation record
      console.log('SUPABASE_SAVE: Email not found in database, creating new record');
      
      // First, create a contact - use a simpler approach to avoid transaction issues
      console.log('SUPABASE_SAVE: Creating new contact');
      let contactId;
      
      try {
        // Direct insert without transaction for better reliability
        const { data: newContact, error: createContactError } = await this.supabase
          .from('contacts')
          .insert({})
          .select('id')
          .single();
          
        if (createContactError) {
          console.error('SUPABASE_SAVE_ERROR: Failed to create contact', {
            error: createContactError.message,
            code: createContactError.code
          });
          throw new Error(`Failed to create contact: ${createContactError.message}`);
        }
        
        contactId = newContact.id;
        console.log('SUPABASE_SAVE: Created new contact', { contactId });
      } catch (contactError) {
        console.error('SUPABASE_SAVE_ERROR: Exception creating contact', { error: contactError.message });
        throw contactError;
      }
      
      // Now insert the email validation record
      const validationData = {
        contact_id: contactId,
        date_last_um_check: validationResult.date_last_um_check || now.toISOString(),
        date_last_um_check_epoch: validationResult.date_last_um_check_epoch || Math.floor(now.getTime() / 1000),
        um_check_id: umCheckId,
        um_email: validationResult.currentEmail || validationResult.um_email || originalEmail,
        email: originalEmail,
        um_email_status: umEmailStatus,
        um_bounce_status: umBounceStatus,
        client_id: clientId || null // Store the client ID that requested this validation
      };
      
      try {
        console.log('SUPABASE_SAVE: Creating new validation record', {
          contactId,
=======
      } else if (existingRecord && existingRecord.length > 0) {
        console.log('SUPABASE_SAVE: Found existing record for email', {
>>>>>>> 1d24bda1fcba04241d52043fecadb0d4d18e1465
          email: originalEmail,
          recordId: existingRecord[0].id,
          contactId: existingRecord[0].contact_id,
          lastChecked: existingRecord[0].date_last_um_check
        });
        
        // Always update the existing record with fresh validation data
        const umCheckId = validationResult.um_check_id || this.generateUmCheckId(clientId);
        const now = new Date();
        
        // Map validation status to um_email_status and um_bounce_status
        let umEmailStatus = validationResult.um_email_status || 'Unable to change';
        let umBounceStatus = validationResult.um_bounce_status || 'Unknown';
        
        if (!validationResult.um_email_status) {
          if (validationResult.wasCorrected) {
            umEmailStatus = 'Changed';
          } else {
            umEmailStatus = 'Unchanged';
          }
        }
        
        if (!validationResult.um_bounce_status) {
          if (validationResult.status === 'valid') {
            umBounceStatus = 'Unlikely to bounce';
          } else if (validationResult.status === 'invalid') {
            umBounceStatus = 'Likely to bounce';
          }
        }
        
        // Prepare update data
        const updateData = {
          date_last_um_check: validationResult.date_last_um_check || now.toISOString(),
          date_last_um_check_epoch: validationResult.date_last_um_check_epoch || Math.floor(now.getTime() / 1000),
          um_check_id: umCheckId,
          um_email: validationResult.currentEmail || validationResult.um_email || originalEmail,
          um_email_status: umEmailStatus,
          um_bounce_status: umBounceStatus,
          // Only update client_id if provided and the existing record doesn't have one
          client_id: clientId !== null ? clientId : existingRecord[0].client_id
        };
        
        console.log('SUPABASE_SAVE: Updating existing validation record', {
          id: existingRecord[0].id,
          contactId: existingRecord[0].contact_id,
          email: originalEmail
        });
        
        const { data: updatedRecord, error: updateError } = await this.supabase
          .from('email_validations')
          .update(updateData)
          .eq('id', existingRecord[0].id)
          .select()
          .single();
          
        if (updateError) {
          console.error('SUPABASE_SAVE_ERROR: Failed to update existing record', {
            error: updateError.message,
            code: updateError.code
          });
          throw new Error(`Failed to update existing record: ${updateError.message}`);
        }
        
        console.log('SUPABASE_SAVE: Successfully updated existing validation record', {
          email: originalEmail,
          operation: 'update',
          id: updatedRecord.id
        });
        
        return { 
          success: true, 
          operation: 'update', 
          data: updatedRecord 
        };
      }
    } catch (checkError) {
      console.error('SUPABASE_SAVE_ERROR: Exception checking for existing record', { 
        error: checkError.message 
      });
      // Continue with insert as fallback
    }
    
    // If we reach here, no existing record was found or there was an error checking
    // Create a check ID for this validation if not already present
    const umCheckId = validationResult.um_check_id || this.generateUmCheckId(clientId);
    const now = new Date();
    
    // Map validation status to um_email_status and um_bounce_status
    let umEmailStatus = validationResult.um_email_status || 'Unable to change';
    let umBounceStatus = validationResult.um_bounce_status || 'Unknown';
    
    if (!validationResult.um_email_status) {
      if (validationResult.wasCorrected) {
        umEmailStatus = 'Changed';
      } else {
        umEmailStatus = 'Unchanged';
      }
    }
    
    if (!validationResult.um_bounce_status) {
      if (validationResult.status === 'valid') {
        umBounceStatus = 'Unlikely to bounce';
      } else if (validationResult.status === 'invalid') {
        umBounceStatus = 'Likely to bounce';
      }
    }
    
    // First, create a contact - use a simpler approach to avoid transaction issues
    console.log('SUPABASE_SAVE: Creating new contact');
    let contactId;
    
    try {
      // Direct insert without transaction for better reliability
      const { data: newContact, error: createContactError } = await this.supabase
        .from('contacts')
        .insert({})
        .select('id')
        .single();
        
      if (createContactError) {
        console.error('SUPABASE_SAVE_ERROR: Failed to create contact', {
          error: createContactError.message,
          code: createContactError.code
        });
        throw new Error(`Failed to create contact: ${createContactError.message}`);
      }
      
      contactId = newContact.id;
      console.log('SUPABASE_SAVE: Created new contact', { contactId });
    } catch (contactError) {
      console.error('SUPABASE_SAVE_ERROR: Exception creating contact', { error: contactError.message });
      throw contactError;
    }
    
    // Now insert the email validation record
    const validationData = {
      contact_id: contactId,
      date_last_um_check: validationResult.date_last_um_check || now.toISOString(),
      date_last_um_check_epoch: validationResult.date_last_um_check_epoch || Math.floor(now.getTime() / 1000),
      um_check_id: umCheckId,
      um_email: validationResult.currentEmail || validationResult.um_email || originalEmail,
      email: originalEmail,
      um_email_status: umEmailStatus,
      um_bounce_status: umBounceStatus,
      client_id: clientId || null // Store the client ID that requested this validation
    };
    
    try {
      console.log('SUPABASE_SAVE: Creating new validation record', {
        contactId,
        email: originalEmail,
        umEmail: validationData.um_email,
        clientId: clientId || 'default'
      });
      
      const { data, error } = await this.supabase
        .from('email_validations')
        .insert(validationData)
        .select()
        .single();
        
      if (error) {
        console.error('SUPABASE_SAVE_ERROR: Failed to insert validation record', {
          error: error.message,
          code: error.code
        });
        throw new Error(`Failed to insert validation record: ${error.message}`);
      }
      
      console.log('SUPABASE_SAVE: Successfully saved validation result', {
        email: originalEmail,
        operation: 'insert',
        id: data.id,
        clientId: clientId || 'default'
      });
      
      return { success: true, operation: 'insert', data };
    } catch (validationError) {
      console.error('SUPABASE_SAVE_ERROR: Exception creating validation record', { 
        error: validationError.message 
      });
      throw validationError;
    }
  } catch (error) {
    console.error('SUPABASE_SAVE_ERROR:', { 
      message: error.message, 
      stack: error.stack,
      email: originalEmail 
    });
    return { success: false, error: error.message };
  }
}