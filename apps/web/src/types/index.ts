export type SignalCategory =
  | 'police_patrol' | 'foot_patrol' | 'bicycle_patrol'
  | 'road_check' | 'incident' | 'protest'
  | 'public_action' | 'temp_restriction'
  | 'emergency' | 'unusual_activity';

export type TrustState = 'ghost' | 'low' | 'medium' | 'high' | 'verified';

export interface Signal {
  id: string;
  category: SignalCategory;
  lat: number;
  lng: number;
  description?: string;
  image_url?: string;
  trust_score: number;
  confirmation_count: number;
  freshness: number;
  trust_state: TrustState;
  is_active: boolean;
  created_at: string | Date;
  expires_at: string | Date;
  updated_at?: string | Date;
}
