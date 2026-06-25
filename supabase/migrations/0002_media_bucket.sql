-- Public bucket holding agent-generated images (e.g. Instagram posts).
-- Public so Instagram's Graph API can fetch the image by URL.
insert into storage.buckets (id, name, public)
values ('mc-media', 'mc-media', true)
on conflict (id) do nothing;
