import React from 'react';
import USMap from '@/components/dashboard/USMap';
import SubscriptionCard from '@/components/SubscriptionCard';

const Dashboard: React.FC = () => {
  return (
    <div className="h-full relative">
      <USMap />
      {/* Only renders for an account without an active plan. */}
      <div className="absolute top-3 left-3 right-3 z-30">
        <SubscriptionCard />
      </div>
    </div>
  );
};

export default Dashboard;
