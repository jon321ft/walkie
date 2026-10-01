-- Profiles table (extends auth.users)
create table profiles (
  id uuid references auth.users not null primary key,
  full_name text,
  avatar_url text,
  role text check (role in ('admin', 'member', 'guest')),
  created_at timestamp with time zone default timezone('utc', now()) not null,
  updated_at timestamp with time zone default timezone('utc', now())
);

-- Channels table
create table channels (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  description text,
  created_at timestamp with time zone default timezone('utc', now()) not null
);

-- Channel members (many-to-many)
create table channel_members (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid references profiles(id) not null,
  channel_id uuid references channels(id) not null,
  joined_at timestamp with time zone default timezone('utc', now()) not null,
  unique(profile_id, channel_id)
);

-- Transmissions (voice messages)
create table transmissions (
  id uuid primary key default uuid_generate_v4(),
  speaker_id uuid references profiles(id) not null,
  channel_id uuid references channels(id) not null,
  started_at timestamp with time zone not null,
  ended_at timestamp with time zone,
  duration_seconds integer,
  audio_url text,
  created_at timestamp with time zone default timezone('utc', now()) not null
);

-- Indexes for performance
create index idx_transmissions_channel_started on transmissions(channel_id, started_at desc);
create index idx_transmissions_speaker on transmissions(speaker_id);
create index idx_channel_members_profile on channel_members(profile_id);
create index idx_channel_members_channel on channel_members(channel_id);

-- Enable RLS
alter table profiles enable row level security;
alter table channels enable row level security;
alter table channel_members enable row level security;
alter table transmissions enable row level security;

-- RLS Policies

-- Profiles: Users can view their own profile and teammates' profiles
create policy "Profiles are viewable by team members"
  on profiles for select
  using (
    auth.uid() = id OR
    EXISTS (
      SELECT 1 FROM channel_members cm
      JOIN channels c ON cm.channel_id = c.id
      WHERE cm.profile_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM channel_members cm2
          WHERE cm2.channel_id = c.id
            AND cm2.profile_id = profiles.id
        )
    )
  );

-- Profiles: Users can update their own profile
create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);

-- Channels: Anyone can view channels (for discovery)
create policy "Channels are viewable by everyone"
  on channels for select
  using (true);

-- Channel members: Users can view their own memberships
create policy "Users can view own channel memberships"
  on channel_members for select
  using (auth.uid() = profile_id);

-- Channel members: Users can join/leave channels
create policy "Users can modify own channel memberships"
  on channel_members for insert
  using (auth.uid() = profile_id);

-- Transmissions: Anyone can view transmissions in channels they belong to
create policy "Transmissions viewable by channel members"
  on transmissions for select
  using (
    EXISTS (
      SELECT 1 FROM channel_members cm
      WHERE cm.channel_id = transmissions.channel_id
        AND cm.profile_id = auth.uid()
    )
  );

-- Transmissions: Only the speaker can insert their own transmission
create policy "Users can insert own transmissions"
  on transmissions for insert
  with check (auth.uid() = speaker_id);