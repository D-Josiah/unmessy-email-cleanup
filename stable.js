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
      } else if (existingRecord && existingRecord.length > 0) {
        console.log('SUPABASE_SAVE: Found existing record for email', {
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