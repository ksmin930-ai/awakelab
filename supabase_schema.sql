-- ==========================================================
-- AWAKE LAB (합주실 예약 시스템) Supabase PostgreSQL Schema
-- ==========================================================
-- 목적: 예약 중복 방지(GiST EXCLUDE), 4주 정기권 및 고정팀 지원, 고객/관리자 조회
-- 실행 위치: Supabase Dashboard -> SQL Editor
-- ==========================================================

-- 1. GiST 인덱스에서 = 연산자를 사용하기 위한 btree_gist 확장 활성화
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. 기존 테이블이 있다면 백업 또는 필요시 재생성 (신규 세팅 시 사용)
-- DROP TABLE IF EXISTS reservations CASCADE;

CREATE TABLE IF NOT EXISTS reservations (
    id BIGSERIAL PRIMARY KEY,
    reservation_no VARCHAR(50) NOT NULL,
    room_id INTEGER NOT NULL DEFAULT 1,
    period TSTZRANGE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    booker_name VARCHAR(100) NOT NULL,
    booker_phone VARCHAR(30) NOT NULL,
    base_amount INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 상태값 제약 조건
    CONSTRAINT chk_reservation_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),

    -- [핵심] 동일 룸(room_id)에서 활성 예약(pending 또는 confirmed) 간 시간 중복 물리적 원천 차단
    -- 중복 예약 시 PostgreSQL 에러코드 '23P01' (exclusion_violation) 발생 -> 프론트에서 즉시 안내 처리
    CONSTRAINT reservations_no_overlap EXCLUDE USING gist (
        room_id WITH =,
        period WITH &&
    ) WHERE (status IN ('pending', 'confirmed'))
);

-- 3. 빠른 검색 및 조회를 위한 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_reservation_no ON reservations(reservation_no);
CREATE INDEX IF NOT EXISTS idx_reservations_phone ON reservations(booker_phone);
CREATE INDEX IF NOT EXISTS idx_reservations_created_at ON reservations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_period ON reservations USING gist(period);

-- 4. RLS (Row Level Security) 설정
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- 익명/클라이언트 직접 조회 허용 (API 서버 함수를 거치지 않고 직접 조회할 경우를 위한 정책)
DROP POLICY IF EXISTS "Allow select for all" ON reservations;
CREATE POLICY "Allow select for all" ON reservations
    FOR SELECT USING (true);

-- Service Role Key는 RLS를 완전 우회하므로 Netlify Functions 백엔드 연동 시 정상 동작합니다.
-- 필요 시 authenticated/anon INSERT/UPDATE 정책:
DROP POLICY IF EXISTS "Allow insert for service role" ON reservations;
CREATE POLICY "Allow insert for service role" ON reservations
    FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow update for service role" ON reservations;
CREATE POLICY "Allow update for service role" ON reservations
    FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow delete for service role" ON reservations;
CREATE POLICY "Allow delete for service role" ON reservations
    FOR DELETE USING (true);

-- 5. 고정팀 예시 데이터 (워십웨이커스 매주 토요일 09:00~12:00 고정)
-- 필요한 경우 주석을 해제하여 초기 데이터를 삽입할 수 있습니다.
/*
INSERT INTO reservations (reservation_no, room_id, period, status, booker_name, booker_phone, base_amount, amount)
VALUES (
    'FIXED-INITIAL-01',
    1,
    tstzrange('2026-09-12 09:00:00+09', '2026-09-12 12:00:00+09', '[)'),
    'confirmed',
    '[고정] 워십웨이커스',
    '01062406569',
    90000,
    90000
);
*/

-- 6. 편의용: 테스트 데이터 전체 정리 쿼리 (필요시 수동 실행)
-- DELETE FROM reservations WHERE booker_name LIKE '%테스트%';
