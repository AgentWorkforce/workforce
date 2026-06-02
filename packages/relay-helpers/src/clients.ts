import type { IntegrationClientOptions } from '@agentworkforce/runtime/clients';
import { providerClient, type ProviderClient } from './provider-client.js';

/**
 * Named, resource-keyed clients for every provider in the writeback-path
 * catalog. `linear` / `github` / `slack` get richer ergonomic clients in their
 * own modules; the rest are uniform resource-keyed clients here.
 *
 * Each exposes its catalog resources as `.{resource}.{path,write,read,list}`,
 * e.g. `notionClient().pages.write({ databaseId }, { ... })`.
 */
export const asanaClient = (opts?: IntegrationClientOptions): ProviderClient<'asana'> => providerClient('asana', opts);
export const azureBlobClient = (opts?: IntegrationClientOptions): ProviderClient<'azure-blob'> => providerClient('azure-blob', opts);
export const boxClient = (opts?: IntegrationClientOptions): ProviderClient<'box'> => providerClient('box', opts);
export const clickupClient = (opts?: IntegrationClientOptions): ProviderClient<'clickup'> => providerClient('clickup', opts);
export const confluenceClient = (opts?: IntegrationClientOptions): ProviderClient<'confluence'> => providerClient('confluence', opts);
export const dropboxClient = (opts?: IntegrationClientOptions): ProviderClient<'dropbox'> => providerClient('dropbox', opts);
export const gcsClient = (opts?: IntegrationClientOptions): ProviderClient<'gcs'> => providerClient('gcs', opts);
export const gitlabClient = (opts?: IntegrationClientOptions): ProviderClient<'gitlab'> => providerClient('gitlab', opts);
export const gmailClient = (opts?: IntegrationClientOptions): ProviderClient<'gmail'> => providerClient('gmail', opts);
export const googleCalendarClient = (opts?: IntegrationClientOptions): ProviderClient<'google-calendar'> => providerClient('google-calendar', opts);
export const googleDriveClient = (opts?: IntegrationClientOptions): ProviderClient<'google-drive'> => providerClient('google-drive', opts);
export const granolaClient = (opts?: IntegrationClientOptions): ProviderClient<'granola'> => providerClient('granola', opts);
export const hubspotClient = (opts?: IntegrationClientOptions): ProviderClient<'hubspot'> => providerClient('hubspot', opts);
export const intercomClient = (opts?: IntegrationClientOptions): ProviderClient<'intercom'> => providerClient('intercom', opts);
export const jiraClient = (opts?: IntegrationClientOptions): ProviderClient<'jira'> => providerClient('jira', opts);
export const notionClient = (opts?: IntegrationClientOptions): ProviderClient<'notion'> => providerClient('notion', opts);
export const onedriveClient = (opts?: IntegrationClientOptions): ProviderClient<'onedrive'> => providerClient('onedrive', opts);
export const pipedriveClient = (opts?: IntegrationClientOptions): ProviderClient<'pipedrive'> => providerClient('pipedrive', opts);
export const postgresClient = (opts?: IntegrationClientOptions): ProviderClient<'postgres'> => providerClient('postgres', opts);
export const redditClient = (opts?: IntegrationClientOptions): ProviderClient<'reddit'> => providerClient('reddit', opts);
export const redisClient = (opts?: IntegrationClientOptions): ProviderClient<'redis'> => providerClient('redis', opts);
export const s3Client = (opts?: IntegrationClientOptions): ProviderClient<'s3'> => providerClient('s3', opts);
export const salesforceClient = (opts?: IntegrationClientOptions): ProviderClient<'salesforce'> => providerClient('salesforce', opts);
export const sharepointClient = (opts?: IntegrationClientOptions): ProviderClient<'sharepoint'> => providerClient('sharepoint', opts);
export const teamsClient = (opts?: IntegrationClientOptions): ProviderClient<'teams'> => providerClient('teams', opts);
export const zendeskClient = (opts?: IntegrationClientOptions): ProviderClient<'zendesk'> => providerClient('zendesk', opts);
